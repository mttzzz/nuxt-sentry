const LF = 10;
function buildUserPatch(injection) {
  const patch = {};
  if (injection.user.id) {
    patch.id = injection.user.id;
  }
  if (injection.user.email) {
    patch.email = injection.user.email;
  }
  if (injection.user.username) {
    patch.username = injection.user.username;
  }
  if (injection.ip) {
    patch.ip_address = injection.ip;
  }
  return patch;
}
function indexOfByte(buf, byte, from) {
  return buf.indexOf(byte, from);
}
export function enrichEnvelope(envelope, injection) {
  const userPatch = buildUserPatch(injection);
  if (Object.keys(userPatch).length === 0) {
    return envelope;
  }
  const headerEol = indexOfByte(envelope, LF, 0);
  if (headerEol === -1) {
    return envelope;
  }
  const out = [envelope.subarray(0, headerEol + 1)];
  let pos = headerEol + 1;
  const total = envelope.length;
  while (pos < total) {
    const itemHeaderEol = indexOfByte(envelope, LF, pos);
    if (itemHeaderEol === -1) {
      out.push(envelope.subarray(pos));
      break;
    }
    const itemHeaderBuf = envelope.subarray(pos, itemHeaderEol);
    pos = itemHeaderEol + 1;
    let itemHeader;
    try {
      itemHeader = JSON.parse(itemHeaderBuf.toString("utf8"));
    } catch {
      itemHeader = null;
    }
    let payload;
    let hadTrailingLF = false;
    if (itemHeader && typeof itemHeader.length === "number") {
      const payloadLen = itemHeader.length;
      payload = envelope.subarray(pos, pos + payloadLen);
      pos += payloadLen;
      if (pos < total && envelope[pos] === LF) {
        hadTrailingLF = true;
        pos++;
      }
    } else {
      const payloadEol = indexOfByte(envelope, LF, pos);
      if (payloadEol === -1) {
        payload = envelope.subarray(pos);
        pos = total;
      } else {
        payload = envelope.subarray(pos, payloadEol);
        pos = payloadEol + 1;
        hadTrailingLF = true;
      }
    }
    const type = itemHeader?.type;
    const shouldEnrich = type === "event" || type === "transaction";
    if (shouldEnrich && itemHeader) {
      let mutatedPayload = null;
      try {
        const event = JSON.parse(payload.toString("utf8"));
        if (event && typeof event === "object") {
          const existing = event.user && typeof event.user === "object" ? event.user : {};
          event.user = { ...existing, ...userPatch };
          mutatedPayload = Buffer.from(JSON.stringify(event), "utf8");
        }
      } catch {
        mutatedPayload = null;
      }
      if (mutatedPayload) {
        if (typeof itemHeader.length === "number") {
          itemHeader.length = mutatedPayload.length;
        }
        out.push(Buffer.from(`${JSON.stringify(itemHeader)}
`, "utf8"));
        out.push(mutatedPayload);
        if (hadTrailingLF) {
          out.push(Buffer.from("\n", "utf8"));
        }
        continue;
      }
    }
    out.push(itemHeaderBuf);
    out.push(Buffer.from("\n", "utf8"));
    out.push(payload);
    if (hadTrailingLF) {
      out.push(Buffer.from("\n", "utf8"));
    }
  }
  return Buffer.concat(out);
}
