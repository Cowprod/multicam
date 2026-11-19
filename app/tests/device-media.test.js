"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/ui/device-media.js"), "utf8"), { window, Date });
const media = window.MultiCamDeviceMedia;
module.exports.register = function (h) {
 const t = h.it;
 h.describe("Device media shared projection", function () {
 t("Storage publishes telemetry without a camera or fabricated preview", () => {
  const v = media.project({deviceId:"storage", roles:["storage"], connected:true, hasCamera:false,
    telemetry:{batteryLevel:71, freeBytes:100, totalBytes:200}, nowMs:10000});
  assert.equal(v.previewStatus,"no_camera");
  assert.equal(v.image,null);
  assert.equal(v.freePercent,50);
  assert.equal(v.batteryLevel,71);
});
t("Capture stale frame never appears live", () => {
  const v = media.project({deviceId:"capture", connected:true, hasCamera:true,
    frame:{jpegBase64:"jpeg",receivedAt:1000}, nowMs:8000});
  assert.equal(v.previewStatus,"waiting");
  assert.equal(v.image,null);
  assert.equal(v.frameAgeMs,7000);
});
t("Capture fresh frame is visible and missing measures stay unknown", () => {
  const v = media.project({deviceId:"capture", connected:true, hasCamera:true,
    frame:{jpegBase64:"jpeg",receivedAt:9000}, nowMs:10000});
  assert.equal(v.previewStatus,"live");
  assert.equal(v.batteryLevel,null);
  assert.equal(v.freePercent,null);
});
t("Offline Capture differs from Storage without camera", () => {
  assert.equal(media.project({hasCamera:true,connected:false}).previewStatus,"offline");
  assert.equal(media.project({hasCamera:false,connected:false}).previewStatus,"no_camera");
});
 });
};
