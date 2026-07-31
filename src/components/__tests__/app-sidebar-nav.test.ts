import { describe, expect, it } from "vitest";
import { groupNav, isBranchActive, type NavItemData } from "../app-sidebar";

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
    { to: "/calls/analytics", label: "Analytics Center", icon, separatorBefore: true },
    { to: "/calls/diagnostics", label: "Diagnostics", icon },
  ],
};

describe("isBranchActive", () => {
  it("marks the parent active while the user is on one of its children", () => {
    // The defect: exact matching left the whole Calls branch looking inactive
    // at the one moment it most needs to look active.
    expect(isBranchActive(calls, "/calls/telesales")).toBe(true);
    expect(isBranchActive(calls, "/calls/analytics")).toBe(true);
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
