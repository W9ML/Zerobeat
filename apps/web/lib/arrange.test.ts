import { describe, expect, it } from "vitest";

import { mergeOrder, moveTo, placeNear } from "./arrange.ts";

describe("card order", () => {
  const defaults = ["contact", "station", "wanted", "auto", "spots", "activity"];

  it("is the default until the operator moves something", () => {
    expect(mergeOrder(defaults, null)).toEqual(defaults);
  });

  it("keeps the saved order and fits new cards in after their default neighbour", () => {
    expect(mergeOrder(defaults, ["activity", "auto", "contact", "spots"])).toEqual(["activity", "auto", "contact", "station", "wanted", "spots"]);
    expect(mergeOrder(["new", ...defaults], ["spots", "contact"])).toEqual(["new", "spots", "activity", "contact", "station", "wanted", "auto"]);
  });

  it("drops cards that no longer exist and repeated ids", () => {
    expect(mergeOrder(["a", "b"], ["b", "gone", "b", "a"])).toEqual(["b", "a"]);
  });

  it("moves a card to a new place", () => {
    expect(moveTo(defaults, "spots", 0)).toEqual(["spots", "contact", "station", "wanted", "auto", "activity"]);
    expect(moveTo(defaults, "contact", 9)).toEqual(["station", "wanted", "auto", "spots", "activity", "contact"]);
  });

  it("drops a card before or after another", () => {
    expect(placeNear(defaults, "activity", "contact", false)).toEqual(["activity", "contact", "station", "wanted", "auto", "spots"]);
    expect(placeNear(defaults, "contact", "auto", true)).toEqual(["station", "wanted", "auto", "contact", "spots", "activity"]);
    expect(placeNear(defaults, "spots", "spots", true)).toEqual(defaults);
  });
});
