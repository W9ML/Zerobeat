import "server-only";
import { resolve } from "node:path";

import { qslCardFile, qslCardPath } from "@zerobeat/core/qsl/card-path";

export const dataDir = () => resolve(process.env.ZEROBEAT_DATA ?? "./data");
/** A user's QSL card picture: their own, or the shack's old one for its owner (core qsl/card-path). */
export const cardPath = (userId: string, legacyOwner?: string | null) => qslCardPath(dataDir(), userId, legacyOwner);
/** Where a user's uploaded card picture is kept. */
export const cardUploadPath = (userId: string) => qslCardFile(dataDir(), userId);
/** A user's own SSTV pictures to send ("My pictures"): data/sstv-library/<userId>/<id>.jpg. */
export const sstvLibraryDir = (userId: string) => resolve(dataDir(), "sstv-library", userId.replace(/[^\w-]/g, ""));
/** A library picture's id: what the server named it. */
export const isLibraryId = (id: string) => /^[\w-]{6,64}$/.test(id);
