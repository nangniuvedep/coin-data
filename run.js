// Runs the data job: engine.bin, unlocked with the ENGINE_KEY secret.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), Module = require("module");
const key = Buffer.from(process.env.ENGINE_KEY || "", "base64");
if (key.length !== 32) { console.error("failed: ENGINE_KEY missing"); process.exit(1); }
const b = Buffer.from(fs.readFileSync(path.join(__dirname, "engine.bin"), "utf8"), "base64");
const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
d.setAuthTag(b.subarray(12, 28));
const m = new Module(path.join(__dirname, "engine.js"), module);
m.filename = m.id;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"), m.filename);
m.exports.cli();
