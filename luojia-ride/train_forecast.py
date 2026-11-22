"""Aggregate supplied trips, train a ReLU/Adam regressor, export browser weights."""
import csv
import gzip
import json
import os
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
import numpy as np

ROOT = Path(__file__).resolve().parent
RAW = ROOT / ".local-data/training/raw"
START = date(2026, 1, 1)
counts = Counter()
seen = set()
quality = Counter()
with (RAW/"trip_sample_2000.csv").open(encoding="utf-8-sig") as stream:
    fields = next(csv.reader(stream))
for path in sorted(RAW.glob("*.csv.gz")):
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as stream:
        # Monthly gzip exports contain records without a header.
        for row in csv.DictReader(stream, fieldnames=fields):
            if row.get("ride_id") == "ride_id":
                continue
            quality["raw_rows"] += 1
            ride = row["ride_id"]
            if ride in seen:
                quality["duplicates"] += 1
                continue
            seen.add(ride)
            try:
                start = datetime.fromisoformat(row["started_at"])
                end = datetime.fromisoformat(row["ended_at"])
                duration = (end - start).total_seconds()
                station = row["start_station_id"]
                if not station or not 60 <= duration <= 14400:
                    raise ValueError()
                index = (start.date() - START).days
                if not 0 <= index < 181:
                    raise ValueError()
            except (ValueError, KeyError):
                quality["invalid_time_or_station"] += 1
                continue
            counts[station, index] += 1
            quality["accepted"] += 1
print(dict(quality), flush=True)
stations = sorted({station for station, day in counts})
series = np.array([[counts[station, day] for day in range(181)] for station in stations], dtype=float)

def features(history):
    window = np.asarray(history)[-7:]
    scale = max(1., float(window.mean()))
    return window / scale, scale

def samples(begin, end):
    xs, ys = [], []
    for values in series:
        for day in range(begin, end):
            x, scale = features(values[:day])
            xs.append(x)
            ys.append([values[day] / scale])
    return np.array(xs), np.array(ys)

# No target dated May or June contributes to fitting or normalization.
xt, yt = samples(7, 120)
xv, yv = samples(120, 151)
center, spread = xt.mean(axis=0), np.maximum(xt.std(axis=0), .01)
xt, xv = (xt-center)/spread, (xv-center)/spread
rng = np.random.default_rng(42)
dims = [7, 32, 16, 1]
weights = [rng.normal(0, np.sqrt(2/a), (a,b)) for a,b in zip(dims[:-1],dims[1:])]
biases = [np.zeros((1,b)) for b in dims[1:]]
parameters = weights + biases
first = [np.zeros_like(p) for p in parameters]
second = [np.zeros_like(p) for p in parameters]
step = 0

def forward(x):
    activations = [x]
    for i,(w,b) in enumerate(zip(weights,biases)):
        z = activations[-1] @ w + b
        activations.append(z if i == 2 else np.maximum(z,0))
    return activations

best = float("inf")
best_state = None
stale = 0
log = []
for epoch in range(1, 101):
    order = rng.permutation(len(xt))
    for offset in range(0,len(xt),256):
        ids = order[offset:offset+256]
        a = forward(xt[ids])
        delta = 2*(a[-1]-yt[ids])/len(ids)
        dw, db = [None]*3, [None]*3
        for i in range(2,-1,-1):
            dw[i] = a[i].T @ delta + .0001*weights[i]
            db[i] = delta.sum(axis=0,keepdims=True)
            delta = (delta @ weights[i].T)*(a[i]>0)
        step += 1
        for p,g,m,v in zip(parameters,dw+db,first,second):
            np.clip(g,-10,10,out=g)
            m *= .9
            m += .1*g
            v *= .999
            v += .001*g*g
            p -= .001*(m/(1-.9**step))/(np.sqrt(v/(1-.999**step))+1e-8)
    loss = float(np.mean((forward(xv)[-1]-yv)**2))
    log.append({"epoch":epoch,"validation_mse_scaled":loss})
    if loss < best-1e-6:
        best, stale = loss, 0
        best_state = [p.copy() for p in parameters]
    else:
        stale += 1
    if epoch%10 == 0:
        print(epoch, loss, flush=True)
    if stale>=12:
        break
for p,saved in zip(parameters,best_state):
    p[:] = saved

def forecast(history, horizon):
    result = list(history)
    for _ in range(horizon):
        x,scale = features(result)
        value = max(0., round(float(forward(((x-center)/spread)[None,:])[-1][0,0])*scale))
        result.append(value)
    return result[-horizon:]

def metrics(pred, actual):
    p,a = np.asarray(pred),np.asarray(actual)
    error = np.abs(p-a)
    wape = float(error.sum()/a.sum()) if a.sum() else None
    return {"mae":float(error.mean()),"wape":wape,
            "score_percent":max(0.,100*(1-wape)) if wape is not None else None}

evaluation = {}
for horizon in range(1,31):
    predictions, actual, baseline = [],[],[]
    # Origins advance daily in June; every full horizon remains inside June.
    for day in range(151,182-horizon):
        for values in series:
            history = values[day-7:day]
            predictions.extend(forecast(history,horizon))
            actual.extend(values[day:day+horizon])
            baseline.extend([round(float(history[-3:].mean()))]*horizon)
    evaluation[str(horizon)]={"dnn":metrics(predictions,actual),"baseline":metrics(baseline,actual),
                              "forecast_values":len(actual),"origins":31-horizon}
artifact = {"version":"2026-11-22","input_days":7,"max_horizon":30,
    "center":center.tolist(),"spread":spread.tolist(),
    "weights":[w.tolist() for w in weights],"biases":[b[0].tolist() for b in biases],
    "evaluation":evaluation,"quality":dict(quality),
    "source":"用户 raw.rar，含 generation_stats.json 的生成记录",
    "train":"2026-01-01 至 2026-04-30","validation":"2026-05-01 至 2026-05-31",
    "test":"2026-06-01 至 2026-06-30","stations":len(stations),
    "best_validation_mse":best,"training_log":log,"seed":42,
    "demo":series[0,-30:].astype(int).tolist()}
out = ROOT / "models"
out.mkdir(exist_ok=True)
(out/"ride_dnn.json").write_text(json.dumps(artifact,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps({"h1":evaluation["1"],"h3":evaluation["3"],"h30":evaluation["30"]},ensure_ascii=False),flush=True)
