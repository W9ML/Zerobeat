"use client";
/** The distance unit from the engine snapshot, for cards deep in the Operate page. */
import { createContext, useContext } from "react";

import type { DistanceUnit } from "@/lib/distance";

export const DistanceUnitContext = createContext<DistanceUnit>("mi");

export function useDistanceUnit(): DistanceUnit {
  return useContext(DistanceUnitContext);
}
