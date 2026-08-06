import { describe, expect, it } from "vitest";
import { groupNav, isBranchActive, resolveActivePath, type NavItemData } from "../app-sidebar";

/**
 * The sidebar itself needs a browser to look at, but the two things that were
 * actually wrong with it are pure functions over the nav tree, so they are
 * pinned here rather than left to be eyeballed.
 */

const icon = () => null;

const calls: NavItemData = {
  to: "/calls",
  label: "Calls",
  icon,
  children: [
    { to: "/calls/customer-care", label: "Customer Care", icon },
    { to: "/calls/telesales", label: "Telesales", icon },
    { to: "/calls/lookup", label: "Call Lookup", icon, separatorBefore: true },
    { to: "/calls/diagnostics", label: "Diagnostics", icon },
  ],
};

describe("isBranchActive", () => {
  it("marks the parent active while the user is on one of its children", () => {
    // The defect: exact matching left the whole Calls branch looking inactive
    // at the one moment it most needs to look active.
    expect(isBranchActive(calls, "/calls/telesales")).toBe(true);
    expect(isBranchActive(calls, "/calls/lookup")).toBe(true);
  });

  it("marks the parent active on its own page", () => {
    expect(isBranchActive(calls, "/calls")).toBe(true);
  });

  it("leaves the parent inactive elsewhere", () => {
    expect(isBranchActive(calls, "/orders")).toBe(false);
    expect(isBranchActive(calls, "/dashboard")).toBe(false);
  });

  it("does not match on a path that merely starts with the same text", () => {
    // "/calls-archive" is a different feature, not a child of "/calls".
    expect(isBranchActive(calls, "/calls-archive")).toBe(false);
  });

  it("handles an item with no children", () => {
    expect(isBranchActive({ to: "/orders", label: "Orders", icon }, "/orders")).toBe(true);
    expect(isBranchActive({ to: "/orders", label: "Orders", icon }, "/complaints")).toBe(false);
  });
});

describe("resolveActivePath", () => {
  const nav: NavItemData[] = [
    { to: "/dashboard", label: "Dashboard", icon },
    { to: "/orders", label: "Orders", icon },
    calls,
  ];

  it("resolves a child route to the child, not to its parent", () => {
    // The defect. Only top-level items were candidates, so this returned
    // "/calls" — which is why the open child never highlighted, why
    // isBranchActive's child arm never ran in production, and why the flyout
    // stayed open when moving between two siblings.
    expect(resolveActivePath(nav, "/calls/telesales")).toBe("/calls/telesales");
    expect(resolveActivePath(nav, "/calls/lookup")).toBe("/calls/lookup");
  });

  it("still resolves a detail route up to its top-level item", () => {
    // No child matches, so the parent prefix is correctly the best candidate.
    expect(resolveActivePath(nav, "/orders/123")).toBe("/orders");
  });

  it("resolves a parent's own page to the parent", () => {
    expect(resolveActivePath(nav, "/calls")).toBe("/calls");
  });

  it("prefers the longest match when parent and child both apply", () => {
    expect(resolveActivePath(nav, "/calls/telesales/detail")).toBe("/calls/telesales");
  });

  it("does not match a sibling path that merely shares a prefix", () => {
    expect(resolveActivePath(nav, "/calls-archive")).toBe("");
  });

  it("returns empty for a path outside the nav tree", () => {
    expect(resolveActivePath(nav, "/settings")).toBe("");
  });

  it("feeds isBranchActive a value that lights the parent branch", () => {
    // The two functions have to agree: this is the pairing the sidebar relies
    // on to keep Calls lit while the user is on one of its children.
    const active = resolveActivePath(nav, "/calls/telesales");
    expect(isBranchActive(calls, active)).toBe(true);
  });

  it("changes between siblings, so close-on-navigate actually fires", () => {
    expect(resolveActivePath(nav, "/calls/telesales")).not.toBe(
      resolveActivePath(nav, "/calls/customer-care"),
    );
  });
});

describe("groupNav", () => {
  const nav: NavItemData[] = [
    { to: "/dashboard", label: "Dashboard", icon },
    { to: "/orders", label: "Orders", icon },
    calls,
    { to: "/admin/users", label: "Users", icon },
    { to: "/branches", label: "Branches", icon },
  ];

  it("puts Calls with the other day-to-day work, not in a section of its own", () => {
    // It previously had a section headed "Calls" whose only item was also
    // called "Calls" — a heading repeating its only child.
    const groups = groupNav(nav);
    const workspace = groups.find((g) => g.id === "workspace");
    expect(workspace?.items.map((i) => i.to)).toContain("/calls");
    expect(groups.some((g) => g.label === "Calls")).toBe(false);
  });

  it("never loses an item to grouping", () => {
    const groups = groupNav(nav);
    const grouped = groups.flatMap((g) => g.items.map((i) => i.to));
    expect(grouped.sort()).toEqual(nav.map((n) => n.to).sort());
  });

  it("drops empty sections rather than rendering bare headings", () => {
    const groups = groupNav([{ to: "/branches", label: "Branches", icon }]);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });
});
