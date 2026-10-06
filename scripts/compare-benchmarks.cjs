'use strict';
const fs = require('node:fs');
const [beforeFile, afterFile, output] = process.argv.slice(2);
if (!beforeFile || !afterFile || !output) throw new Error('Usage: compare-benchmarks.cjs baseline.json optimized.json summary.md');
const before = JSON.parse(fs.readFileSync(beforeFile)), after = JSON.parse(fs.readFileSync(afterFile));
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function metrics(report) {
    if (report.error) return null;
    const idle = report.samples.filter((sample) => sample.stage === 'idle');
    const active = report.samples.filter((sample) => /^active/.test(sample.stage));
    const sumRss = (sample) => sample.metrics.reduce((n, metric) => n + (metric.memory?.workingSetSize || 0), 0) / 1024;
    const validProc = report.samples.every((sample) => sample.pidNamespaceConsistent && sample.metrics.every((metric) => metric.memory?.workingSetSize > 0 && metric.fdCount !== null));
    const mainRss = (sample) => sample.mainMemory.rss / 1024 ** 2;
    const uiPid = (sample) => sample.contents.find((wc) => wc.type === 'window')?.pid;
    const uiRss = (sample) => (sample.metrics.find((metric) => metric.pid === uiPid(sample))?.memory?.workingSetSize || 0) / 1024;
    const shellRss = (sample) => {
        const taskPids = new Set(sample.contents.filter((wc) => wc.type === 'browserView').map((wc) => wc.pid));
        return sample.metrics.filter((metric) => !taskPids.has(metric.pid)).reduce((n, metric) => n + (metric.memory?.workingSetSize || 0), 0) / 1024;
    };
    const cpu = (sample) => sample.metrics.reduce((n, metric) => n + (metric.cpu?.percentCPUUsage || 0), 0);
    const ipcTotal = (sample) => Object.values(sample.ipc.received).reduce((a, b) => a + b, 0) + Object.values(sample.ipc.sent).reduce((a, b) => a + b, 0);
    const first = active[0], last = active.at(-1);
    const seconds = (last.uptimeMs - first.uptimeMs) / 1000;
    return {
        'Startup (ms)': report.startupMs,
        'Idle main RSS (MiB)': mean(idle.map(mainRss)),
        'Idle UI renderer RSS (MiB)': validProc ? mean(idle.map(uiRss)) : null,
        'Idle shell RSS sum (MiB)': validProc ? mean(idle.map(shellRss)) : null,
        'Active full app RSS sum (MiB)': validProc ? mean(active.map(sumRss)) : null,
        'Idle summed CPU (%)': validProc ? mean(idle.map(cpu)) : null,
        'Active summed CPU (%)': validProc ? mean(active.map(cpu)) : null,
        'Idle main CPU (%)': mean(idle.map((sample) => sample.mainCpuPercent)),
        'Active main CPU (%)': mean(active.map((sample) => sample.mainCpuPercent)),
        'UI rAF cadence under active load (fps)': mean(active.map((sample) => sample.rendererFramesPerSecond)),
        'Main event-loop p99 under active load (ms)': mean(active.map((sample) => sample.eventLoopDelayMs.p99)),
        'Active IPC messages/sec': seconds > 0 ? (ipcTotal(last) - ipcTotal(first)) / seconds : null,
        'Active timers (mean)': mean(active.map((sample) => sample.activeTimers)),
        'Active known listeners (mean)': mean(active.map((sample) => Object.values(sample.listeners).reduce((a, b) => a + b, 0))),
        'Active child processes (mean)': mean(active.map((sample) => sample.metrics.length - 1)),
        'Active file descriptors (mean)': validProc ? mean(active.map((sample) => sample.metrics.reduce((n, metric) => n + metric.fdCount, 0))) : null,
        'Main file descriptors (mean)': mean(active.map((sample) => sample.mainFileDescriptors)),
        'Main RSS change over active window (MiB)': mainRss(last) - mainRss(first),
        'Full app RSS change over active window (MiB)': validProc ? sumRss(last) - sumRss(first) : null,
        'Contents after pool recreation': report.workspaceRecreationCounts.at(-1),
        'Shutdown (ms)': report.shutdownMs,
        'Surviving child processes': report.survivingChildren?.length ?? null
    };
}
const b = metrics(before), a = metrics(after);
const format = (value) => value == null ? 'unavailable' : value.toFixed(2);
let text = '# Ubuntu baseline comparison\n\nSame Electron 31.2.1, Xvfb/software rendering, explicit CI-only no-sandbox flag, isolated temporary profiles, local proxy/page fixtures. Search discovery is substituted in both test apps; public Google interaction is not tested. Reports include probe instrumentation overhead. RSS sums can count shared Chromium pages multiple times. FPS is requestAnimationFrame cadence, not a compositor trace. Listener count covers known owned emitters; timer count covers main-process JS timers, not Chromium internal timers.\n\n';
if (!b || !a) { text += `Incomplete comparison. Baseline error: ${before.error || 'none'}\n\nOptimized error: ${after.error || 'none'}\n`; }
else {
    text += '| Metric | Original | Optimized | Change |\n| --- | ---: | ---: | ---: |\n';
    for (const key of Object.keys(b)) text += `| ${key} | ${format(b[key])} | ${format(a[key])} | ${format(a[key] === null || b[key] === null ? null : a[key] - b[key])} |\n`;
}
text += '\nUnavailable process metrics mean /proc PID visibility is incomplete or inconsistent; zero-valued inaccessible metrics are not interpreted as memory or CPU savings. Orphan checks validate executable ownership and are unavailable when the PID namespace cannot be observed reliably.\n';
text += `\nActive duration: baseline ${before.activeSeconds}s, optimized ${after.activeSeconds}s. Browser count: ${after.testedBrowserCount}. Short runtime checks do not establish 24/7 stability or prove absence of leaks. Longer soak tests and real VPS X11/Wayland graphics validation remain necessary.\n`;
fs.writeFileSync(output, text); console.log(text);
