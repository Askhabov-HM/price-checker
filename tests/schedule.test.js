import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleSettings, scheduledSlot, nextScheduledCheck} from '../src/schedule.js';
import {Tracker} from '../src/service.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {temporary, cleanup} from './helpers.js';

test('schedule settings preserve saved times and normalize midnight without duplicate runs', () => {
  const previous = {schedule_mode: 'hours', schedule: ['00:30', '09:00'], interval_minutes: 60, schedule_enabled: true};
  assert.deepEqual(scheduleSettings({schedule_enabled: false}, previous), {...previous, schedule_enabled: false});
  const config = scheduleSettings({schedule_enabled: true, schedule: ['24:00', '00:00', '23:00']}, previous);
  assert.deepEqual(config.schedule, ['00:00', '23:00']);
  const next = nextScheduledCheck(config, new Date('2026-10-19T23:30:00+03:00'));
  assert.equal(Date.parse(next), Date.parse('2026-10-20T00:00:00+03:00'));
  assert.throws(() => scheduleSettings({schedule_enabled: true, schedule: []}, previous));
  assert.throws(() => scheduleSettings({schedule_enabled: true, interval_minutes: 45}, previous));
});

test('interval schedules identify only the latest missed slot and schedule the following one', () => {
  const config = {schedule_mode: 'interval', interval_minutes: 30, schedule_anchor: '2026-10-19T06:00:00.000Z'};
  assert.equal(scheduledSlot(config, new Date('2026-10-19T05:59:00Z')), null);
  assert.equal(scheduledSlot(config, new Date('2026-10-19T08:17:00Z')), '2026-10-19T08:00:00.000Z');
  assert.equal(nextScheduledCheck(config, new Date('2026-10-19T08:17:00Z')), '2026-10-19T08:30:00.000Z');
});

test('changing either store schedule preserves the other store settings across restart', async t => {
  const root = temporary(t), current = () => Date.parse('2026-10-19T06:00:00Z');
  const client = {configured: () => true, close: async () => {}};
  let tracker = new Tracker(root, {client: {}}), ozon = new OzonService(root, {client, current});
  cleanup(t, async () => {await ozon.close(); await tracker.close();});
  assert.equal(ozon.status().interval_minutes, 30);
  const initialOzon = ozon.scheduleConfig();
  tracker.saveSettings({schedule_enabled: true, schedule_mode: 'hours', schedule: ['09:00', '20:00'], interval_minutes: 120});
  assert.deepEqual(ozon.scheduleConfig(), initialOzon);
  const randewoo = tracker.status();
  ozon.settings({schedule_enabled: true, schedule_mode: 'interval', interval_minutes: 60});
  for (const field of ['schedule_enabled', 'schedule_mode', 'schedule', 'interval_minutes']) {
    assert.deepEqual(tracker.status()[field], randewoo[field]);
  }
  const savedOzon = ozon.scheduleConfig();
  await ozon.close(); await tracker.close();
  tracker = new Tracker(root, {client: {}}); ozon = new OzonService(root, {client, current});
  assert.deepEqual(ozon.scheduleConfig(), savedOzon);
  assert.deepEqual(tracker.status().schedule, ['09:00', '20:00']);
  assert.equal(tracker.status().schedule_mode, 'hours');
});
