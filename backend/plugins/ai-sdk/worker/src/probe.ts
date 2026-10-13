import { isAbsolute } from "node:path";
import { loadSdk } from "./sdk.js";
import { PROFILE } from "./protocol.js";
import { exitCandidate } from "./shutdown.js";

async function probe(): Promise<void> {
  const call_id = process.env.DF_SDK_CALL_ID ?? "";
  const nonce = process.env.DF_SDK_NONCE ?? "";
  const entry = process.env.DF_SDK_SDK_ENTRY ?? "";
  if (!call_id || call_id.length > 64 || !/^[0-9a-f]{64}$/i.test(nonce)
      || !isAbsolute(entry) || process.version !== "v24.14.0"
      || process.env.DF_SDK_PROFILE !== PROFILE) throw new Error("官方SDK加载探测资格无效");
  await loadSdk(entry);
  exitCandidate({ call_id, nonce }, "success");
}

try { await probe(); } catch {
  process.stderr.write("官方SDK加载探测失败\n");
  process.exitCode = 1;
}
