import { open } from "node:fs/promises";

// On macOS a flush empties the whole drive cache, and hundreds of test files
// making rarely-used durable saves at once queue on it until they time out.
// Tests skip the flush itself; what they check is which saves ask for one.
const probe = await open(process.execPath, "r");
const handle = Object.getPrototypeOf(probe);
await probe.close();
handle.sync = async () => {};
handle.datasync = async () => {};
