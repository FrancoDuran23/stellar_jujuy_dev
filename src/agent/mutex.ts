// Relocated to shared/mutex.ts in WU7 (Lote E) so server/channel-service.ts
// can reuse the same primitive without crossing the agent/server folder
// boundary. Re-exported here unchanged so no existing import breaks.
export { createChannelMutex, type ChannelMutex } from "../shared/mutex.ts";
