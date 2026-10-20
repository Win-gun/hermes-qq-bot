// Apply a committed JSON state without invalidating group/user references held
// by in-flight operations. This is not a merge: the draft must be based on the
// latest live state and durably committed before calling this function.
// Publication itself must not yield before updating the runtime's revision.
const object = (value) => value !== null && typeof value === "object";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function reconcileMemoryInPlace(target, source) {
  if (!object(target) || !object(source) || Array.isArray(target) !== Array.isArray(source)) {
    throw new TypeError("Memory reconciliation requires matching JSON containers");
  }
  for (const key of Object.keys(target)) if (!own(source, key)) delete target[key];
  for (const key of Object.keys(source)) {
    const before = own(target, key) ? target[key] : undefined;
    const after = source[key];
    if (before === after) continue;
    if (object(before) && object(after) && Array.isArray(before) === Array.isArray(after)) {
      reconcileMemoryInPlace(before, after);
    } else {
      Object.defineProperty(target, key, { value: structuredClone(after), enumerable: true, configurable: true, writable: true });
    }
  }
  if (Array.isArray(target)) target.length = source.length;
  return target;
}

export function commitMemoryDraft(memory, draft, save) {
  // A failed save leaves the live object untouched. No asynchronous gap is
  // allowed between persistence and applying the committed state in memory.
  const revision = save(draft);
  reconcileMemoryInPlace(memory, draft);
  return revision;
}
