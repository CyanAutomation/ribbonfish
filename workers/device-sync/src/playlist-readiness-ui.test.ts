import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderPlaylistReadiness } from "../public/admin/playlist-readiness-view.ts";

test("playlist readiness view presents deterministic blockers, freshness, recipients, and shadow result safely", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const panel = renderPlaylistReadiness({
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
  }, { ownerDocument: dom.window.document });
  dom.window.document.body.append(panel);

  assert.match(panel.textContent ?? "", /Needs review/);
  assert.match(panel.textContent ?? "", /Fresh captures\s*0 \/ 1/);
  assert.match(panel.textContent ?? "", /pi-office/);
  assert.match(panel.textContent ?? "", /behind/i);
  assert.equal(panel.querySelector(".badge--warning")?.textContent, "Needs review");
  assert.match(panel.textContent ?? "", /JEV shadow assessment/);
  assert.match(panel.textContent ?? "", /awaiting device sync/);
  assert.equal(panel.querySelectorAll(".playlist-readiness-a2ui__card").length, 6);
  assert.equal(panel.querySelector("script"), null);
  dom.window.close();
});

test("playlist readiness view exposes an explicit shadow assessment action", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  let assessments = 0;
  const panel = renderPlaylistReadiness({
    revision: { playlist_id: "office", revision: "rev-1" },
    status: "ready",
    summary: { total_items: 0, total_captures: 0, fresh_captures: 0, missing_assets: 0, stale_captures: 0, disabled_captures: 0, unreviewed_schedules: 0, devices_to_update: 0 },
    blockers: [], warnings: [], items: [], devices_to_update: [], latest_assessment: null,
  }, { ownerDocument: dom.window.document, onAssess: async () => { assessments += 1; } });
  panel.querySelector<HTMLButtonElement>("button[data-a2ui-event='assess_readiness']")?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(assessments, 1);
  dom.window.close();
});
