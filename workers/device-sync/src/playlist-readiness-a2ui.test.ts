import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createPlaylistReadinessA2uiMessage,
  parsePlaylistReadinessAction,
  renderPlaylistReadinessA2ui,
} from "../public/admin/playlist-readiness-a2ui.ts";

const readiness = {
  revision: { playlist_id: "office", revision: "rev-1" },
  status: "review",
  summary: {
    total_items: 3,
    total_captures: 1,
    fresh_captures: 0,
    missing_assets: 0,
    stale_captures: 1,
    disabled_captures: 0,
    unreviewed_schedules: 0,
    devices_to_update: 1,
  },
  blockers: [],
  warnings: ["stale_captures"],
  items: [{ label: "Capture 1", status: "stale" }],
  devices_to_update: [{ device_id: "pi-office", sync_status: "behind" }],
  latest_assessment: {
    deterministic_status: "review",
    answers: { assessment: { choice: "ready" }, risk: { label: "Low" } },
    observed_outcome: "awaiting_device_sync",
  },
};

test("playlist readiness uses the shared A2UI catalog and describes deterministic and JEV evidence", () => {
  const message = createPlaylistReadinessA2uiMessage(readiness);

  assert.equal(message.createSurface.surfaceId, "playlistReadiness");
  assert.equal(message.createSurface.catalogId, "https://ribbonfish.dev/a2ui/catalogs/management-v2.json");
  assert.equal(message.createSurface.components.some((component) => component.component === "Badge"), true);
  assert.equal(message.createSurface.components.some((component) => component.component === "Button"), true);
  assert.match(JSON.stringify(message.createSurface.dataModel), /Missing assets/);
  assert.match(JSON.stringify(message.createSurface.dataModel), /stale captures/);
  assert.match(JSON.stringify(message.createSurface.dataModel), /awaiting device sync/);
  assert.doesNotMatch(JSON.stringify(message), /javascript:|<script/i);
});

test("playlist readiness renders text safely and dispatches only its revision-bound JEV assessment action", async () => {
  const dom = new JSDOM("<div id='readiness'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#readiness");
  assert.ok(container);
  const actions: unknown[] = [];
  const hostile = structuredClone(readiness);
  hostile.items[0]!.label = "<img src=x onerror=alert(1)>";

  renderPlaylistReadinessA2ui(container, hostile, (action) => { actions.push(action); });

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
  const button = container.querySelector<HTMLButtonElement>("button[data-a2ui-event='assess_readiness']");
  assert.ok(button);
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(actions, [{
    name: "assess_readiness",
    context: { playlist_id: "office", revision: "rev-1" },
    sourceComponentId: "assessReadinessButton",
  }]);
  dom.window.close();
});

test("A2UI assessment buttons announce and prevent duplicate work while the action is pending", async () => {
  const dom = new JSDOM("<div id='readiness'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#readiness");
  assert.ok(container);
  let resolveAction!: () => void;
  const actionPending = new Promise<void>((resolve) => { resolveAction = resolve; });
  let actionCount = 0;

  renderPlaylistReadinessA2ui(container, readiness, () => {
    actionCount += 1;
    return actionPending;
  });

  const button = container.querySelector<HTMLButtonElement>("button[data-a2ui-event='assess_readiness']");
  assert.ok(button);
  button.click();
  button.click();
  assert.equal(actionCount, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.textContent, "Assessing readiness…");

  resolveAction();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute("aria-busy"), false);
  assert.equal(button.textContent, "Run JEV shadow assessment");
  dom.window.close();
});

test("playlist readiness action parsing binds to the current playlist revision", () => {
  const action = {
    name: "assess_readiness",
    context: { playlist_id: "office", revision: "rev-1" },
    sourceComponentId: "assessReadinessButton",
  };
  assert.equal(parsePlaylistReadinessAction(action, readiness), true);
  assert.equal(parsePlaylistReadinessAction({ ...action, context: { ...action.context, revision: "rev-2" } }, readiness), false);
  assert.equal(parsePlaylistReadinessAction({ ...action, context: { ...action.context, extra: true } }, readiness), false);
  assert.equal(parsePlaylistReadinessAction({ ...action, name: "activate_playlist" }, readiness), false);
});

test("invalid playlist readiness actions leave the current UI intact", () => {
  const dom = new JSDOM("<div id='readiness'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#readiness");
  assert.ok(container);
  const message = structuredClone(createPlaylistReadinessA2uiMessage(readiness));
  const button = message.createSurface.components.find((component) => component.id === "assessReadinessButton");
  assert.ok(button);
  button.action = { event: { name: "activate_playlist", context: { playlist_id: "office", revision: "rev-1" } } };

  assert.throws(() => renderPlaylistReadinessA2ui(container, readiness, undefined, message), /unsupported action/i);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});
