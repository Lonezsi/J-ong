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
  try {
    response = await fetch(path, opts);
  } catch (e) {
    throw new Error("J-ong is not answering. Is the server still running?");
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
