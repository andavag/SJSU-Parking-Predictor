import { uploadPayload, type Crossing, type StoredCrossing } from "./crossingTypes";
export type Acknowledgement = { clientEventId: string; status: "accepted" | "duplicate" | "rejected"; error?: string };
export async function uploadCrossings(
  events: StoredCrossing[], upload: (events: Crossing[]) => Promise<Acknowledgement[]>,
  synced: (id: string) => Promise<unknown>, failed: (id: string, attempts: number, at: number) => Promise<unknown>,
  rejected: (id: string, message: string) => Promise<unknown>, now = Date.now
): Promise<void> {
  let acknowledgements: Acknowledgement[];
  try {
    acknowledgements = await upload(events.map(uploadPayload));
    if (!Array.isArray(acknowledgements)) throw new Error("Invalid server acknowledgement.");
  } catch (error) {
    for (const event of events) await failed(event.clientEventId, event.attempts + 1, now());
    throw error;
  }
  for (const event of events) {
    const matches = acknowledgements.filter(ack => ack?.clientEventId === event.clientEventId);
    const ack = matches.length === 1 ? matches[0] : undefined;
    if (ack?.status === "accepted" || ack?.status === "duplicate") await synced(event.clientEventId);
    else if (ack?.status === "rejected") await rejected(event.clientEventId, typeof ack.error === "string" ? ack.error : "Server rejected this crossing.");
    else await failed(event.clientEventId, event.attempts + 1, now());
  }
}
