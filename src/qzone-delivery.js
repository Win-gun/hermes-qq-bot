// QZone is a separate social surface, never a private-chat send or a generic
// read. This classifier is also used at the raw transport boundary. Unknown
// QZone aliases fail closed; only the host runtime may issue an opaque proof.
import { QZONE_READ_ACTIONS, QZONE_WRITE_ACTIONS, isQzoneAction } from "./qzone-policy.js";
export { QZONE_READ_ACTIONS, QZONE_WRITE_ACTIONS, isQzoneAction };
export function qzoneActionKind(action) {
  return QZONE_READ_ACTIONS.includes(action) ? "read"
    : QZONE_WRITE_ACTIONS.includes(action) ? "write" : isQzoneAction(action) ? "unknown" : "other";
}
export const isUnmanagedFavoriteWrite = action => [
  "add_custom_face", "delete_custom_face", "move_custom_face", "rename_custom_face"
].includes(action);
