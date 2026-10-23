// security's interactive command reader accepts at most a bounded line. Keep
// secrets off argv, reject unsupported input before mutation, and let callers
// verify the stored value before they report success.
export function keychainPasswordWriteInput(account, service, secret) {
  if (![account, service].every((value) => typeof value === "string" && /^[\x20-\x7e]+$/.test(value))) {
    throw new Error("Keychain 项目格式无效");
  }
  if (typeof secret !== "string" || !/^[\x20-\x7e]+$/.test(secret)) {
    const error = new Error("本机 Keychain 不支持此凭据字符，请改用环境变量配置");
    error.code = "KEYCHAIN_INPUT_UNSUPPORTED";
    throw error;
  }
  const quote = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const input = `add-generic-password -a ${quote(account)} -s ${quote(service)} -U -w ${quote(secret)}\n`;
  if (Buffer.byteLength(input, "utf8") > 4000) {
    const error = new Error("本机 Keychain 凭据过长，请改用环境变量配置");
    error.code = "KEYCHAIN_INPUT_UNSUPPORTED";
    throw error;
  }
  return input;
}
