// Offline inference using the weights exported by train_forecast.py.
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function trainedNext(history) {
  const last = history.slice(-7);
  if (last.every(value => value === 0)) return 0;
  const scale = Math.max(1, mean(last));
  let output = last.map((value, i) => (value / scale - rideModel.center[i]) / rideModel.spread[i]);
  rideModel.weights.forEach((layer, l) => {
    output = rideModel.biases[l].map((bias, j) => {
      const value = output.reduce((sum, input, i) => sum + input * layer[i][j], bias);
      return l === rideModel.weights.length - 1 ? value : Math.max(0, value);
    });
  });
  const result = Math.max(0, Math.round(output[0] * scale));
  if (!Number.isSafeInteger(result)) throw new Error('预测超出可计算范围，请检查输入或缩短预测天数。');
  return result;
}
function predictDays(history, horizon) {
  const combined = [...history];
  for (let i = 0; i < horizon; i++) combined.push(trainedNext(combined));
  return combined.slice(-horizon);
}
function errorMetrics(actual, predictions) {
  const total = actual.reduce((sum, value) => sum + value, 0);
  const errors = actual.map((value, i) => Math.abs(value - predictions[i]));
  const wape = total > 0 ? errors.reduce((sum, value) => sum + value, 0) / total : null;
  return {mae: mean(errors), score: wape === null ? null : Math.max(0, 100 * (1 - wape))};
}
function scoreText(score) {
  return score === null ? '无法计算（实际总人次为零）' : score.toFixed(1) + '%';
}
function resetDailyResult() {
  byId('daily-result').hidden = true;
  byId('daily-status').textContent = '';
  byId('daily-status').className = 'result';
}

let chartData = null;
function drawTrend(history, predictions) {
  chartData = {history, predictions};
  const canvas = byId('daily-chart');
  const width = Math.max(280, canvas.parentElement.clientWidth);
  const height = 300;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  const context = canvas.getContext('2d');
  context.scale(pixelRatio, pixelRatio);
  const left = 65, right = width - 22, top = 28, bottom = 252;
  const values = [...history, ...predictions];
  const maximum = Math.max(1, ...values) * 1.12;
  const x = i => left + i / (values.length - 1) * (right - left);
  const y = value => bottom - value / maximum * (bottom - top);
  context.font = '12px system-ui';
  context.fillStyle = '#52655b';
  for (let i = 0; i <= 4; i++) {
    const value = maximum * i / 4;
    context.strokeStyle = '#dce7dd';
    context.beginPath(); context.moveTo(left, y(value)); context.lineTo(right, y(value)); context.stroke();
    context.fillText(Math.round(value).toLocaleString(), 2, y(value) + 4);
  }
  context.fillText('人次', 2, 15);
  context.fillStyle = '#52655b';
  context.fillText('历史第 1 天', left, bottom + 22);
  context.textAlign = 'center';
  context.fillText('最近一天', x(history.length - 1), bottom + 40);
  context.textAlign = 'right';
  context.fillText('未来第 ' + predictions.length + ' 天', right, bottom + 22);
  context.textAlign = 'left';
  function line(start, end, color, dashed) {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.setLineDash(dashed ? [6, 4] : []);
    context.beginPath();
    for (let i = start; i < end; i++) {
      if (i === start) context.moveTo(x(i), y(values[i]));
      else context.lineTo(x(i), y(values[i]));
    }
    context.stroke();
    context.setLineDash([]);
  }
  line(0, history.length, '#205840', false);
  line(history.length - 1, values.length, '#bc631c', true);
}
window.addEventListener('resize', () => {
  if (chartData && !byId('daily-result').hidden) drawTrend(chartData.history, chartData.predictions);
});
for (const id of ['daily-counts','daily-window','daily-horizon']) {
  byId(id).addEventListener('input', () => { resetDailyResult(); saveFormData(); });
}
byId('daily-example').addEventListener('click', () => {
  const count = Number(byId('daily-window').value);
  if (!Number.isInteger(count) || count < 7 || count > 181) return;
  if (byId('daily-counts').value.trim() && !confirm('将覆盖当前输入，是否继续？')) return;
  byId('daily-counts').value = Array.from({length:count}, (_, i) => rideModel.demo[i % rideModel.demo.length]).join(', ');
  resetDailyResult();
  byId('daily-status').textContent = '已填入训练文件中的生成数据样例。超过 30 天时循环填充，仅用于体验。';
  saveFormData();
});
byId('daily-form').addEventListener('submit', event => {
  event.preventDefault();
  resetDailyResult();
  try {
    const count = Number(byId('daily-window').value);
    const horizon = Number(byId('daily-horizon').value);
    if (!Number.isInteger(count) || count < 7 || count > 181 ||
        !Number.isInteger(horizon) || horizon < 1 || horizon > 30) {
      throw new Error('历史天数须为 7–181 的整数，预测天数须为 1–30 的整数。');
    }
    const tokens = byId('daily-counts').value.trim().replace(/，/g, ',').split(',').flatMap(piece => piece.trim().split(/\s+/));
    if (tokens.length !== count || tokens.some(token => !/^\d{1,9}$/.test(token))) {
      throw new Error('请输入恰好 ' + count + ' 个非负整数，每项最多 9 位，空项和缺测请先补录。');
    }
    const history = tokens.map(Number);
    const predictions = predictDays(history, horizon);
    const baseline = Math.round(mean(history.slice(-3)));
    const metric = rideModel.evaluation[String(horizon)];
    byId('daily-evaluation').textContent = '生成数据独立测试 · ' + horizon +
      ' 天跨度，DNN 参考准确率 ' + scoreText(metric.dnn.score_percent) +
      '，WAPE ' + (metric.dnn.wape * 100).toFixed(1) + '%，MAE ' + metric.dnn.mae.toFixed(1) +
      ' 人次。均值基线参考准确率 ' + scoreText(metric.baseline.score_percent) +
      '。测试起点 ' + metric.origins + ' 个 × ' + rideModel.stations + ' 个区域，累计 ' +
      metric.forecast_values.toLocaleString() + ' 个预测值。';
    const heldout = Math.min(horizon, history.length - 7);
    if (heldout > 0) {
      const actual = history.slice(-heldout);
      const backtest = predictDays(history.slice(0,-heldout), heldout);
      const local = errorMetrics(actual, backtest);
      byId('daily-local').textContent = '当前输入尾段回放 · ' + heldout + ' 天，评分 ' +
        scoreText(local.score) + '，MAE ' + local.mae.toFixed(1) +
        ' 人次。尾段未用于本次递推输入，但可能与预训练数据重合。';
    } else {
      byId('daily-local').textContent = '当前输入只有 7 天，全部用于预测，尚无可留出的本地回测数据。';
    }
    byId('daily-rows').replaceChildren(...predictions.map((value, i) => {
      const row = document.createElement('tr');
      for (const content of ['未来第 ' + (i+1) + ' 天', value + ' 人次', baseline + ' 人次']) row.insertCell().textContent = content;
      return row;
    }));
    byId('daily-status').textContent = '已读取 ' + count + ' 天，预测未来 ' + horizon + ' 天。';
    byId('daily-result').hidden = false;
    drawTrend(history, predictions);
    saveFormData();
  } catch(error) {
    byId('daily-status').textContent = error.message;
    byId('daily-status').className = 'result error-text';
  }
});
