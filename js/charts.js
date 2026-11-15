/*
 * Trade-Forex — chart builders on top of Chart.js.
 *
 * Marks follow one spec everywhere: 2px lines, a ~10% area wash, bars no thicker
 * than 24px with a rounded data end and a square baseline, hairline solid grid,
 * text in ink tokens (never in the series colour). Colours come from the page's
 * CSS variables so both themes share one code path.
 */
(function (root) {
  'use strict';
  var C = root.TFCore;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      series: cssVar('--series'), pos: cssVar('--pos'), neg: cssVar('--neg'), muted: cssVar('--mark-muted'),
      ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'),
      line: cssVar('--line'), baseline: cssVar('--line-strong'), surface: cssVar('--surface'),
      tipBg: cssVar('--tip-bg'), tipInk: cssVar('--tip-ink'), tipSub: cssVar('--tip-sub'),
      font: getComputedStyle(document.body).fontFamily
    };
  }

  function alpha(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function reducedMotion() {
    return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function tooltip(th, getTip) {
    // The value leads (bold); the labels that locate it follow underneath.
    return {
      backgroundColor: th.tipBg, borderColor: th.line, borderWidth: 1, padding: 10, cornerRadius: 8,
      displayColors: false, caretSize: 5,
      titleColor: th.tipInk, titleFont: { family: th.font, size: 14, weight: '600' }, titleMarginBottom: 4,
      bodyColor: th.tipSub, bodyFont: { family: th.font, size: 12, weight: '400' }, bodySpacing: 3,
      callbacks: {
        title: function (items) { return items.length ? getTip(items[0].dataIndex).value : ''; },
        label: function () { return ''; },
        afterBody: function (items) { return items.length ? getTip(items[0].dataIndex).lines : []; }
      }
    };
  }

  function baseOptions(th) {
    return {
      responsive: true, maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 260 },
      layout: { padding: { top: 6, right: 8, bottom: 0, left: 0 } },
      plugins: { legend: { display: false } }
    };
  }

  function axisFont(th) {
    return { family: th.font, size: 11 };
  }

  /* Vertical hairline that snaps to the hovered X position. */
  var crosshair = {
    id: 'tfCrosshair',
    afterDatasetsDraw: function (chart, args, opts) {
      var act = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!act.length) return;
      var x = act[0].element.x, area = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, area.top);
      ctx.lineTo(Math.round(x) + 0.5, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  /* A labelled horizontal reference line (starting balance). */
  var refLine = {
    id: 'tfRefLine',
    beforeDatasetsDraw: function (chart, args, opts) {
      if (opts.value === null || opts.value === undefined) return;
      var y = chart.scales.y.getPixelForValue(opts.value), area = chart.chartArea, ctx = chart.ctx;
      if (y < area.top || y > area.bottom) return;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.left, Math.round(y) + 0.5);
      ctx.lineTo(area.right, Math.round(y) + 0.5);
      ctx.stroke();
      if (opts.label) {
        ctx.font = '11px ' + opts.font;
        ctx.fillStyle = opts.ink;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        var above = y - area.top > 18;
        ctx.textBaseline = above ? 'bottom' : 'top';
        ctx.fillText(opts.label, area.right - 2, y + (above ? -4 : 4));
      }
      ctx.restore();
    }
  };

  /* Value printed at the tip of each bar, in ink. */
  var barLabels = {
    id: 'tfBarLabels',
    afterDatasetsDraw: function (chart, args, opts) {
      if (!opts.fmt) return;
      var meta = chart.getDatasetMeta(0), data = chart.data.datasets[0].data, ctx = chart.ctx;
      var horizontal = chart.options.indexAxis === 'y';
      ctx.save();
      ctx.font = '500 11px ' + opts.font;
      ctx.fillStyle = opts.ink;
      meta.data.forEach(function (bar, i) {
        var v = data[i];
        var text = opts.fmt(v, i);
        if (!text) return;
        if (horizontal) {
          ctx.textBaseline = 'middle';
          ctx.textAlign = v >= 0 ? 'left' : 'right';
          ctx.fillText(text, bar.x + (v >= 0 ? 6 : -6), bar.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = v >= 0 ? 'bottom' : 'top';
          ctx.fillText(text, bar.x, bar.y + (v >= 0 ? -5 : 5));
        }
      });
      ctx.restore();
    }
  };

  /**
   * Single-series line with an area wash and a crosshair tooltip.
   * cfg: { labels, values, tone: 'series'|'neg', fmtTick(v, maxAbs), tip(i) -> {value, lines},
   *        ref: { value, label }, fill: 'start'|'origin', max, endDot }
   */
  function line(canvas, cfg) {
    var th = theme();
    var color = cfg.tone === 'neg' ? th.neg : th.series;
    var last = cfg.values.length - 1;
    var opts = baseOptions(th);
    opts.interaction = { mode: 'index', intersect: false };
    opts.plugins.tooltip = tooltip(th, cfg.tip);
    opts.plugins.tfCrosshair = { color: th.baseline };
    opts.plugins.tfRefLine = cfg.ref ? { value: cfg.ref.value, label: cfg.ref.label, color: th.baseline, ink: th.ink3, font: th.font } : { value: null };
    opts.scales = {
      x: {
        grid: { display: false }, border: { color: th.baseline },
        ticks: { color: th.ink3, font: axisFont(th), maxRotation: 0, autoSkip: true, maxTicksLimit: 6, autoSkipPadding: 24 }
      },
      y: {
        max: cfg.max, grace: cfg.max === undefined ? '6%' : 0,
        grid: { color: th.line, drawTicks: false }, border: { display: false },
        ticks: {
          color: th.ink3, font: axisFont(th), padding: 8, maxTicksLimit: 6,
          callback: function (v) { return cfg.fmtTick(v, Math.max(Math.abs(this.min), Math.abs(this.max))); }
        }
      }
    };
    return new root.Chart(canvas, {
      type: 'line',
      data: {
        labels: cfg.labels,
        datasets: [{
          data: cfg.values,
          borderColor: color, borderWidth: 2, borderJoinStyle: 'round', borderCapStyle: 'round', tension: 0,
          fill: cfg.fill || 'start', backgroundColor: alpha(color, 0.1),
          pointRadius: function (c) { return cfg.endDot !== false && c.dataIndex === last ? 4 : 0; },
          pointHoverRadius: 4, pointBackgroundColor: color,
          pointBorderColor: th.surface, pointBorderWidth: 2, pointHoverBorderColor: th.surface, pointHoverBorderWidth: 2,
          pointHitRadius: 12
        }]
      },
      options: opts,
      plugins: [crosshair, refLine]
    });
  }

  /**
   * Bars from a zero baseline. Polarity (gain/loss) is carried by direction and
   * by colour together, so colour is never the only cue.
   * cfg: { labels, values, horizontal, tones: ['pos'|'neg'|'series'|'muted'] (optional, else by sign),
   *        fmtTick(v, maxAbs), fmtValue(v, i) (optional tip label), tip(i) -> {value, lines}, integer }
   */
  function bars(canvas, cfg) {
    var th = theme();
    var colors = cfg.values.map(function (v, i) {
      var tone = cfg.tones ? cfg.tones[i] : v < 0 ? 'neg' : 'pos';
      return th[tone] || th.series;
    });
    var opts = baseOptions(th);
    var horizontal = !!cfg.horizontal;
    opts.indexAxis = horizontal ? 'y' : 'x';
    opts.plugins.tooltip = tooltip(th, cfg.tip);
    opts.plugins.tfBarLabels = cfg.fmtValue ? { fmt: cfg.fmtValue, ink: th.ink2, font: th.font } : { fmt: null };
    var valueAxis = {
      beginAtZero: true, grace: cfg.fmtValue ? (horizontal ? '22%' : '14%') : '5%',
      grid: {
        drawTicks: false,
        color: function (c) { return c.tick && c.tick.value === 0 ? th.baseline : th.line; }
      },
      border: { display: false },
      ticks: {
        color: th.ink3, font: axisFont(th), padding: 8, maxTicksLimit: horizontal ? 5 : 6, precision: cfg.integer ? 0 : undefined,
        callback: function (v) { return cfg.fmtTick(v, Math.max(Math.abs(this.min), Math.abs(this.max))); }
      }
    };
    var catAxis = {
      grid: { display: false }, border: { display: false },
      ticks: { color: th.ink2, font: { family: th.font, size: 12 }, maxRotation: 0, autoSkip: !horizontal, padding: 6 }
    };
    opts.scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
    return new root.Chart(canvas, {
      type: 'bar',
      data: {
        labels: cfg.labels,
        datasets: [{
          data: cfg.values,
          backgroundColor: colors,
          hoverBackgroundColor: colors.map(function (c) { return alpha(c, 0.78); }),
          borderRadius: 4, maxBarThickness: 24, categoryPercentage: 0.8, barPercentage: 0.9
        }]
      },
      options: opts,
      plugins: [barLabels]
    });
  }

  root.TFCharts = { line: line, bars: bars, theme: theme, alpha: alpha };
})(typeof self !== 'undefined' ? self : this);
