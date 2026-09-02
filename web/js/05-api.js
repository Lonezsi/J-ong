/* Talking to the server.
 *
 * Every call goes through here so an error has one shape and one place to be reported.
 * A failed request throws with the server's own message, because "could not save" tells
 * you nothing and "a song keeps at least one preset" tells you everything.
 */
"use strict";

J.api = async function (path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  let response;
  // A restart takes a couple of seconds, and during it every request in flight fails.
  // Giving up on the first one turns a blink into a broken screen, so a read is tried
  // again briefly before anything is said. Writes are never retried: sending the same
  // upload twice is worse than reporting the failure.
  const idempotent = !opts.method || opts.method === "GET";
  const attempts = idempotent ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(path, opts);
      break;
    } catch (e) {
      if (attempt >= attempts) {
        throw new Error("J-ong is not answering. It may be restarting; "
                        + "give it a moment and try again.");
      }
      await new Promise((done) => setTimeout(done, attempt * 400));
    }
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`The server sent something that is not JSON (${response.status}).`);
    }
  }
  if (response.status === 401) {
    // The session ran out or was signed out elsewhere. Going to the door is more use
    // than an error message on a screen that can no longer load anything.
    location.href = "/login";
    throw new Error("Signed out.");
  }
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
};

J.get = (path) => J.api(path);
J.post = (path, json) => J.api(path, { method: "POST", json: json || {} });
J.put = (path, json) => J.api(path, { method: "PUT", json: json || {} });
J.patch = (path, json) => J.api(path, { method: "PATCH", json: json || {} });
J.del = (path) => J.api(path, { method: "DELETE" });

/* File uploads are the raw body with the name in a header, which is the same call the
 * desktop client makes. No multipart, no form encoding, nothing to get wrong. */
J.upload = (path, file, extraHeaders) => {
  const headers = Object.assign({
    "Content-Type": "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name).replace(/%20/g, " "),
  }, extraHeaders || {});
  return J.api(path, { method: "POST", headers, body: file });
};

/* Wrap an action so failures always surface instead of vanishing into the console. */
J.try = async function (fn, okMessage) {
  try {
    const result = await fn();
    if (okMessage) J.toast(okMessage);
    return result;
  } catch (e) {
    J.toast(e.message, "bad");
    return null;
  }
};
