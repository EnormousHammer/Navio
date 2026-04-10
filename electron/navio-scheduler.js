/**
 * Navio Browser – Task Scheduler
 *
 * Runs saved workflows on a recurring schedule using simple interval timers.
 * No external dependencies — uses Node.js timers and cron-style parsing.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

let schedulerFile = null;
const activeTimers = new Map(); // scheduleId → { timer, config }

function getSchedulerFile() {
  if (schedulerFile) return schedulerFile;
  schedulerFile = path.join(app.getPath('userData'), 'navio-schedules.json');
  return schedulerFile;
}

function loadSchedules() {
  const file = getSchedulerFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  fs.writeFileSync(getSchedulerFile(), JSON.stringify(schedules, null, 2), 'utf8');
}

/**
 * Parse a simple interval string like "30m", "2h", "1d", "weekly" into milliseconds.
 */
function parseInterval(interval) {
  if (!interval) return null;
  const str = String(interval).trim().toLowerCase();

  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's' || unit === 'sec') return num * 1000;
    if (unit === 'm' || unit === 'min') return num * 60 * 1000;
    if (unit === 'h' || unit === 'hr' || unit === 'hour') return num * 3600 * 1000;
    if (unit === 'd' || unit === 'day') return num * 86400 * 1000;
  }

  const named = {
    'hourly': 3600 * 1000,
    'daily': 86400 * 1000,
    'weekly': 7 * 86400 * 1000,
    'every monday': 7 * 86400 * 1000,
  };
  return named[str] || null;
}

/**
 * Execute a scheduled workflow by sending it to the renderer's assistant.
 */
function executeScheduledWorkflow(schedule) {
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) return;
  const win = wins[0];
  if (!win.webContents) return;

  console.log(`[navio-scheduler] Running scheduled workflow: ${schedule.workflowName}`);
  win.webContents.send('scheduled-workflow-run', {
    scheduleId: schedule.id,
    workflowName: schedule.workflowName,
    prompt: schedule.prompt || `Run the workflow "${schedule.workflowName}"`
  });

  // Update last-run timestamp
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx !== -1) {
    schedules[idx].lastRun = new Date().toISOString();
    schedules[idx].runCount = (schedules[idx].runCount || 0) + 1;
    saveSchedules(schedules);
  }
}

/**
 * Start a timer for a schedule.
 */
function startTimer(schedule) {
  if (activeTimers.has(schedule.id)) return;
  const ms = parseInterval(schedule.interval);
  if (!ms) return;

  const timer = setInterval(() => {
    if (schedule.enabled !== false) {
      executeScheduledWorkflow(schedule);
    }
  }, ms);

  activeTimers.set(schedule.id, { timer, config: schedule });
}

/**
 * Stop a timer for a schedule.
 */
function stopTimer(scheduleId) {
  const entry = activeTimers.get(scheduleId);
  if (entry) {
    clearInterval(entry.timer);
    activeTimers.delete(scheduleId);
  }
}

/**
 * Initialize all active schedules from the saved config.
 */
function initScheduler() {
  const schedules = loadSchedules();
  for (const schedule of schedules) {
    if (schedule.enabled !== false) {
      startTimer(schedule);
    }
  }
  console.log(`[navio-scheduler] Initialized ${activeTimers.size} active schedules`);
}

/**
 * Register IPC handlers for schedule management.
 */
function registerSchedulerIpc(ipcMain) {
  ipcMain.handle('scheduler-list', () => {
    return { ok: true, schedules: loadSchedules() };
  });

  ipcMain.handle('scheduler-add', (event, { workflowName, interval, prompt, enabled }) => {
    const ms = parseInterval(interval);
    if (!ms) return { ok: false, error: `Invalid interval: "${interval}". Use formats like "30m", "2h", "1d", "daily", "weekly".` };

    const schedules = loadSchedules();
    const schedule = {
      id: `sched_${Date.now()}`,
      workflowName,
      interval,
      intervalMs: ms,
      prompt: prompt || '',
      enabled: enabled !== false,
      created: new Date().toISOString(),
      lastRun: null,
      runCount: 0
    };
    schedules.push(schedule);
    saveSchedules(schedules);

    if (schedule.enabled) startTimer(schedule);
    return { ok: true, schedule };
  });

  ipcMain.handle('scheduler-remove', (event, { id }) => {
    stopTimer(id);
    const schedules = loadSchedules().filter(s => s.id !== id);
    saveSchedules(schedules);
    return { ok: true };
  });

  ipcMain.handle('scheduler-toggle', (event, { id, enabled }) => {
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) return { ok: false, error: 'Schedule not found' };
    schedules[idx].enabled = !!enabled;
    saveSchedules(schedules);
    if (enabled) {
      startTimer(schedules[idx]);
    } else {
      stopTimer(id);
    }
    return { ok: true, schedule: schedules[idx] };
  });

  ipcMain.handle('scheduler-run-now', (event, { id }) => {
    const schedules = loadSchedules();
    const schedule = schedules.find(s => s.id === id);
    if (!schedule) return { ok: false, error: 'Schedule not found' };
    executeScheduledWorkflow(schedule);
    return { ok: true };
  });
}

/**
 * Stop all timers (call on app quit).
 */
function stopAll() {
  for (const [id] of activeTimers) {
    stopTimer(id);
  }
}

module.exports = {
  initScheduler,
  registerSchedulerIpc,
  stopAll
};
