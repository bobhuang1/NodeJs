"use strict";
/* httpx response seam — NodeJs port of GoLang internal/httpx/respond.go VERBATIM
 * (status codes, error codes, message strings, envelope shape, 1MiB body cap).
 * Express-flavoured: `res` plays the role of http.ResponseWriter. */
const MAX_BODY = 1 << 20; // io.LimitReader(r.Body, 1<<20)

class APIError extends Error {
  constructor(status, code, message, cause) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.message = message;
    if (cause !== undefined) this.cause = cause;
  }
}

// Common API error constructors (Go: BadRequest/NotFound/Conflict/Unauthorized/
// Forbidden/Internal).
function BadRequest(msg) { return new APIError(400, "bad_request", msg); }
function NotFound(msg) { return new APIError(404, "not_found", msg); }
function Conflict(msg) { return new APIError(409, "conflict", msg); }
function Unauthorized(msg) { return new APIError(401, "unauthorized", msg); }
function Forbidden(msg) { return new APIError(403, "forbidden", msg); }
function Internal(msg, err) { return new APIError(500, "internal", msg, err); }

// Wrap wraps a plain error as a 500; nil stays nil (Go: `return httpx.Wrap(e)`).
function Wrap(err) {
  if (!err) return null;
  return new APIError(500, "internal", "internal error", err);
}

function isAPIError(err) { return err instanceof APIError; }

// WriteJSON writes a JSON body. Mirror of httpx.WriteJSON.
function writeJSON(res, status, payload) {
  if (res.headersSent) return;
  res.set("Content-Type", "application/json; charset=utf-8");
  if (payload === undefined || payload === null) {
    res.status(status).end();
    return;
  }
  res.status(status).send(JSON.stringify(payload));
}

function writeOK(res, payload) { return writeJSON(res, 200, payload); }
function writeCreated(res, payload) { return writeJSON(res, 201, payload); }
function writeNoContent(res) {
  if (res.headersSent) return;
  res.status(204).end();
}

// WriteError maps a value to the error envelope. nil -> 204 (Go: WriteNoContent).
function writeError(res, err) {
  if (!err) { writeNoContent(res); return; }
  const apiErr = isAPIError(err) ? err : null;
  if (apiErr) {
    writeJSON(res, apiErr.status, { error: { code: apiErr.code, message: apiErr.message } });
    return;
  }
  writeJSON(res, 500, { error: { code: "internal", message: "internal error" } });
}

// DecodeJSON reads a request body (bounded, 1MiB) into a plain object.
// On failure writes 400 'malformed JSON body' and resolves null (Go writes the
// error itself and the handler returns). `null` JSON body decodes to {} like a
// Go struct target; non-object bodies are malformed.
function decodeJSON(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (size < MAX_BODY) {
        const room = MAX_BODY - size;
        size += chunk.length;
        chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      // Empty body -> json.Decoder.Decode returns io.EOF -> malformed (Go).
      if (raw === "") {
        writeError(res, BadRequest("malformed JSON body"));
        resolve(null);
        return;
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { /* malformed */ }
      // JSON `null` decodes into a Go struct target as zero values -> {}.
      if (parsed === null) parsed = {};
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        writeError(res, BadRequest("malformed JSON body"));
        resolve(null);
        return;
      }
      resolve(parsed);
    });
    req.on("error", () => {
      writeError(res, BadRequest("malformed JSON body"));
      resolve(null);
    });
  });
}

// ParsePathID parses a route path param as an int64 (Go: chi.URLParam + ParseInt).
function parsePathID(req, name) {
  const raw = req.params ? req.params[name] : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, err: BadRequest("missing path parameter " + name) };
  }
  if (!/^-?\d+$/.test(raw)) {
    return { ok: false, err: BadRequest("invalid path parameter " + name) };
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    return { ok: false, err: BadRequest("invalid path parameter " + name) };
  }
  return { ok: true, id };
}

// ParsePathUUID returns the raw UUID param (validated non-empty).
function parsePathUUID(req, name) {
  const raw = req.params ? req.params[name] : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, err: BadRequest("missing path parameter " + name) };
  }
  return { ok: true, value: raw };
}

module.exports = {
  MAX_BODY,
  APIError,
  BadRequest,
  NotFound,
  Conflict,
  Unauthorized,
  Forbidden,
  Internal,
  Wrap,
  isAPIError,
  writeJSON,
  writeOK,
  writeCreated,
  writeNoContent,
  writeError,
  decodeJSON,
  parsePathID,
  parsePathUUID,
};