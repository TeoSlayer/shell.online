// Local-only browser regression for the disposable workshop preview.
// A throwaway server/profile; one fixed task + cancellation; no real sessions/models.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './server.mjs';
import { launchChromeTransport } from '../lib/browser-transport.mjs';

const server = createApp();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(join(tmpdir(), 'workshop-demo-ui-'));
let browser;
try {
  browser = await launchChromeTransport({ profile });
  await browser.setViewport({ width: 1920, height: 1080, dpr: 1, mobile: false });
  await browser.navigate(url);
  const snap = () => browser.evaluate('window.__workshopDemo?.snapshot()');
  const click = selector => browser.call(function (s) { document.querySelector(s).click(); }, selector);
  const choose = (selector, value) => browser.call(function (s, v) {
    const node = document.querySelector(s); node.value = v;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
  const waitFor = async (check, label, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail(`Timed out: ${label}`);
  };
  for (let n = 0; n < 100; n++) {
    if (await browser.evaluate('!!window.__workshopDemo && !document.getElementById("loading")')) break;
    await delay(50);
  }
  let state = await snap();
  assert.equal(state.activityMode, 'local-sandbox');
  assert.equal(state.droneCount, 9);
  assert.equal(state.daily.totalCompleted, 0);
  assert.equal(state.daily.delivered, 0);
  assert.equal(state.assets.owner, true);
  assert.equal(state.assets.courier, true);
  assert.equal(state.terrainCache.tintStrength, .14);
  assert.equal(new Set(state.ownerIdentities.map(owner => owner.color)).size, 3);
  assert.ok(state.droneStates.every(drone => drone.state === 'idle'));
  const origins = state.droneStates.map(drone => [drone.id, drone.station]);
  await choose('#agents-per-owner', '12');
  state = await snap();
  assert.equal(state.droneCount, 36);
  assert.equal(state.ownerSlots.length, 3 * Math.ceil(12 / state.capacityPerSector));
  for (const [id, point] of origins) assert.deepEqual(state.droneStates.find(drone => drone.id === id).station, point);
  assert.ok(Object.values(Object.groupBy(state.droneStates, drone => drone.sectorId)).every(group => group.length <= state.capacityPerSector));
  await choose('#agents-per-owner', '3');
  await delay(100);
  state = await snap();
  assert.equal(state.ownerSlots.filter(sector => sector.active).length, 3);
  assert.ok(state.labels.every(label => !label.text.includes('0/0')));
  // Fresh default world for visual acceptance; history stability was checked above.
  await browser.navigate(url);
  for (let n = 0; n < 100; n++) {
    if (await browser.evaluate('!!window.__workshopDemo && !document.getElementById("loading")')) break;
    await delay(50);
  }
  await click('#owner-legend summary');
  await click('[data-legend-owner="1"]');
  assert.ok(await browser.evaluate('document.getElementById("owner-legend").open'));
  await click('#owner-legend summary');
  await click('#focus-mine');
  await choose('#parcel-source', 'owner:1');
  await click('#send-parcel');
  assert.equal((await snap()).packet.courier.stage, 'docked');
  await click('#parcel-next');
  await delay(1000);
  state = await snap();
  assert.equal(state.packet.courier.stage, 'outbound');
  assert.equal(state.boardedOwnerId, 1);
  assert.ok(Number.isFinite(state.packet.courier.heading));
  assert.ok(Number.isFinite(state.packet.courier.bank));
  assert.equal(state.droneStates[0].state, 'idle');
  assert.equal(state.droneStates[0].finishedAt, 0);
  await click('#parcel-next');
  assert.equal((await snap()).boardedOwnerId, 1);
  await delay(1400);
  state = await snap();
  assert.equal(state.packet.courier.stage, 'return');
  assert.equal(state.boardedOwnerId, 1);
  assert.ok(Math.abs(state.packet.position.x - state.packet.targetAnchor.x) < 1);
  assert.equal((await snap()).droneStates[0].state, 'idle');
  await waitFor(async () => (await snap()).packet.courier.done, 'courier landing', 2000);
  state = await snap();
  assert.equal(state.boardedOwnerId, null);
  assert.equal(state.packet.courier.phase, 'done');
  const landingObservedAt = Date.now();
  await waitFor(() => browser.evaluate('!document.getElementById("start-job").disabled'), 'controls re-enable on landing, not the one-second inspector tick', 250);
  const landingControlDelayMs = Date.now() - landingObservedAt;
  await choose('#parcel-source', 'gateway:external');
  await click('#start-job');
  await waitFor(async () => { const current = await snap(); return current.activeJob && current.droneStates[0].state === 'working'; }, 'actual runner admission/start', 3000);
  state = await snap();
  assert.equal(state.droneStates[0].state, 'working');
  assert.equal(state.droneStates[0].evidence.source, 'local-sandbox');
  assert.equal(state.boardedOwnerId, null);
  assert.ok(Number.isFinite(state.packet.courier.x));
  assert.ok(Number.isFinite(state.packet.courier.y));
  await waitFor(async () => { const current = await snap(); return current.droneStates[0].workVisual.integrated && current.droneStates[0].workVisual.frame >= 2; }, 'real work reaches an animated typing frame', 5000);
  state = await snap();
  assert.equal(state.droneStates[0].workVisual.integrated, true);
  assert.equal(state.animation.workFrames, 7);
  assert.ok(Math.abs(state.droneStates[0].grippers.x - state.droneStates[0].keyboard.x) < .1);
  assert.ok(Math.abs(state.droneStates[0].grippers.y - state.droneStates[0].keyboard.y) < .1);
  await waitFor(async () => !(await snap()).activeJob, 'actual runner completion');
  state = await snap();
  assert.equal(state.droneStates[0].state, 'finished');
  assert.equal(state.droneStates[0].evidence.type, 'completed');
  assert.equal(state.daily.totalCompleted, 1);
  assert.equal(state.daily.delivered, 0);
  assert.equal(state.deliveries.length, 1);
  assert.equal(state.deliveries[0].completionDay, state.daily.dayKey);
  assert.equal(typeof state.deliveries[0].completionEventId, 'string');
  assert.equal(state.deliveries[0].jobId, state.droneStates[0].evidence.jobId);
  assert.equal(state.deliveries[0].completionAt, state.droneStates[0].evidence.at);
  assert.equal(state.boardedOwnerId, null, 'neutral output courier never boards an owner');
  await waitFor(async () => (await snap()).daily.delivered === 1, 'completed output reaches its owner depot', 3000);
  state = await snap();
  assert.equal(state.daily.totalCompleted, 1, 'arrival cannot create another completion');
  assert.equal(state.daily.owners[0].completed, 1);
  assert.equal(state.daily.owners[0].delivered, 1);
  assert.equal(state.daily.owners[0].displayed, 1);
  assert.ok(state.daily.owners.slice(1).every(owner => owner.completed === 0 && owner.displayed === 0));
  assert.equal(state.deliveries[0].arrived, true);
  assert.equal(state.deliveries[0].ownerId, 'owner-0');
  await waitFor(async () => { const drone = (await snap()).droneStates[0]; return drone.pose.x === drone.rest.x && drone.pose.y === drone.rest.y; }, 'completed drone returns to grounded rest', 3000);
  state = await snap();
  assert.deepEqual(state.droneStates[0].pose, state.droneStates[0].rest);
  await click('#start-job');
  await waitFor(async () => !!(await snap()).activeJob, 'second actual runner admission', 3000);
  await click('#cancel-job');
  await waitFor(async () => !(await snap()).activeJob, 'actual cancellation evidence', 3000);
  assert.equal((await snap()).droneStates[0].evidence.type, 'cancelled');
  state = await snap();
  assert.equal(state.daily.totalCompleted, 1, 'cancellation cannot credit a crate');
  assert.equal(state.daily.delivered, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal((await snap()).pixelDensity.sceneWidth, (await snap()).pixelDensity.canvasWidth);
  for (const [width, height, mobile] of [[3840, 2160, false], [390, 844, true]]) {
    await browser.setViewport({ width, height, dpr: 1, mobile });
    await delay(100);
    const layout = await browser.evaluate('({overflow:document.documentElement.scrollWidth>innerWidth,target:document.getElementById("start-job").getBoundingClientRect().height,todayDetail:parseFloat(getComputedStyle(document.getElementById("today-detail")).fontSize)})');
    assert.equal(layout.overflow, false);
    assert.ok(layout.target >= 44);
    assert.ok(layout.todayDetail >= (mobile ? 14 : 18));
  }
  console.log(JSON.stringify({ passed: true, stableBenchAnchors: true, courier: true, landingControlDelayMs, ackNeverCompletes: true, realTaskCompletes: true, dailyCompleted: state.daily.totalCompleted, dailyDelivered: state.daily.delivered, cancelledJobCreditsNothing: true, cancellation: true, keyboardContact: true, groundedRest: true, accessibleViewports: ['4K', '390px'] }));
} finally {
  if (browser) await browser.close();
  await rm(profile, { recursive: true, force: true });
  server.jobs.shutdown();
  await new Promise(resolve => server.close(resolve));
}
