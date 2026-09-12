import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

function blocked() {
  process.stderr.write('{"event":"network_blocked","code":"OUTBOUND_NETWORK_DENIED"}\n');
  throw new Error("OUTBOUND_NETWORK_DENIED: offline checks only permit numeric loopback hosts.");
}

function checkHost(host) {
  if (!["127.0.0.1", "::1", "[::1]"].includes(host)) blocked();
}

function checkHttp(args, protocol) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(first);
    if (!["http:", "https:"].includes(url.protocol)) blocked();
    checkHost(url.hostname);
    const overrides = args[1];
    if (overrides && typeof overrides === "object") {
      if (overrides.socketPath) blocked();
      if (overrides.hostname || overrides.host) checkHost(overrides.hostname ?? overrides.host);
    }
  } else {
    if (!first || first.socketPath) blocked();
    checkHost(first.hostname ?? first.host);
    if (first.protocol && first.protocol !== protocol) blocked();
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["http:", "https:"].includes(url.protocol)) blocked();
  checkHost(url.hostname);
  // Manual redirects ensure an allowed local endpoint cannot redirect outside the guard.
  if (init?.redirect && init.redirect !== "error" && init.redirect !== "manual") blocked();
  return originalFetch(input, { ...init, redirect: init?.redirect ?? "error" });
};

for (const [module, protocol] of [[http, "http:"], [https, "https:"]]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = function (...args) {
      checkHttp(args, protocol);
      return Reflect.apply(original, this, args);
    };
  }
}

syncBuiltinESMExports();
