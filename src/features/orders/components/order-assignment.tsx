/**
 * Assignment — who owns this order, and therefore which team it belongs to.
 *
 * ## Agent first, team derived
 *
 * The form used to ask for a team at the top of the page and an agent nowhere,
 * which had the question backwards: an order belongs to a person, and the team
 * is a fact about that person. Picking "Telesales" and then an agent who is in
 * Customer Care was possible, and produced an order filed under a team its
 * agent is not in. So the team selector is gone and this reads the team off the
 * chosen agent's current role — one choice, and it cannot disagree with itself.
 *
 * ## Who may use it
 *
 * Owner and Admin on edit; anyone holding `edit_all_orders` at creation, which
 * additionally covers Supervisor — they cannot be the assignee themselves, so
 * without the picker they could not save an order at all.
 *
 * Both are narrower than what the database permits, never wider, so this control
 * cannot offer an ability that would then be refused. The backstop is the
 * `orders` UPDATE policy: its `WITH CHECK` re-tests the *new* row, so an agent
 * moving their own order to someone else fails `auth.uid() = agent_id` and is
 * rejected. The `orders_prevent_reassignment` trigger is the other half, and it
 * is the one that actually fires: an earlier comment here said it had been
 * dropped in 20260701224822 leaving only the function, which the live catalog
 * disproves — it is present and enabled, and refuses any change to `agent_id`
 * or `team` from a caller without `edit_all_orders`.
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, UserCog, UserPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TEAMS } from "@/lib/branches";
import { FORM_FIELD } from "@/lib/panel";
import { cn } from "@/lib/utils";
import type { DirectoryAgent } from "@/lib/directory";

/** The two operational teams an order can belong to. */
export type OrderTeam = "customer_care" | "telesales";

/**
 * The team an agent's orders belong to.
 *
 * `user_roles.role` *is* the team for the two operational roles — `orders.team`
 * takes the same enum — so there is nothing to map. A directory entry whose role
 * is anything else (admin, auditor, supervisor, or null because RLS hid it) has
 * no team of its own, and the caller keeps whatever the order already had rather
 * than inventing one.
 */
export function teamForAgent(agent: Pick<DirectoryAgent, "role"> | undefined): OrderTeam | null {
  if (agent?.role === "customer_care" || agent?.role === "telesales") return agent.role;
  return null;
}

/**
 * May this person be the agent an order is assigned to?
 *
 * Having a team *is* the test, and that is not a coincidence: an order is filed
 * under a team, and only the two operational roles have one. Owner, Admin,
 * Supervisor and Auditor therefore never appear in the picker — a supervisor is
 * not a caseload, and putting one in agent workload, team splits or the "My
 * orders" filter misreports all three.
 */
export function isAssignableAgent(agent: { role?: string | null } | undefined): boolean {
  return teamForAgent(agent as Pick<DirectoryAgent, "role"> | undefined) !== null;
}

/** Only the people an order may actually be assigned to. */
export function assignableAgents(agents: readonly DirectoryAgent[] | undefined): DirectoryAgent[] {
  return (agents ?? []).filter((a) => isAssignableAgent(a));
}

const teamLabel = (team: string) => TEAMS.find((t) => t.value === team)?.label ?? team;

export function OrderAssignment({
  agents,
  agentId,
  createdById,
  team,
  canAssign,
  disabled,
  onAssign,
}: {
  /** The shared agent directory; only operational roles are offered. */
  agents: DirectoryAgent[] | undefined;
  agentId: string | null | undefined;
  /** Who entered the order. Informational, and never the same field as above. */
  createdById: string | null | undefined;
  team: string;
  canAssign: boolean;
  disabled?: boolean;
  /** Receives both, because choosing the agent is what decides the team. */
  onAssign: (next: { agentId: string; team: OrderTeam | null }) => void;
}) {
  const [open, setOpen] = useState(false);

  /** Only the roles that can hold an order. An admin is not an order's agent. */
  const assignable = useMemo(() => assignableAgents(agents), [agents]);

  const current = useMemo(() => agents?.find((a) => a.id === agentId), [agents, agentId]);
  const creator = useMemo(() => agents?.find((a) => a.id === createdById), [agents, createdById]);
  const derivedTeam = teamForAgent(current) ?? (team || null);

  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1.5">
        <p className={FORM_FIELD.label}>Assigned to</p>
        {canAssign ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-label="Assign order to an agent"
                disabled={disabled}
                className="w-full justify-between font-normal"
              >
                {current ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{current.full_name ?? "Unnamed agent"}</span>
                    {current.agent_code && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {current.agent_code}
                      </span>
                    )}
                  </span>
                ) : (
                  // Deliberately not pre-filled with whoever is looking at it.
                  <span className="text-muted-foreground">Assign to an agent…</span>
                )}
                <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
              <Command>
                <CommandInput placeholder="Search an agent or code…" />
                <CommandList>
                  <CommandEmpty>No agent.</CommandEmpty>
                  <CommandGroup>
                    {assignable.map((agent) => (
                      <CommandItem
                        key={agent.id}
                        value={`${agent.full_name ?? ""} ${agent.agent_code ?? ""}`}
                        onSelect={() => {
                          // Both, in one act: the team is not a second question.
                          onAssign({ agentId: agent.id, team: teamForAgent(agent) });
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            agentId === agent.id ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {agent.full_name ?? "Unnamed agent"}
                        </span>
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                          {teamLabel(agent.role ?? "")}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : (
          // Not a disabled control: an agent who cannot reassign is being told a
          // fact, and a greyed-out picker invites a click that does nothing.
          <p className="flex h-9 items-center gap-2 text-sm">
            <span className="truncate font-medium">{current?.full_name ?? "Unassigned"}</span>
            {current?.agent_code && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {current.agent_code}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-1.5">
        <p className={FORM_FIELD.label}>Team</p>
        <p className="flex h-9 items-center gap-2 text-sm">
          <UserCog className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{derivedTeam ? teamLabel(derivedTeam) : "—"}</span>
          {canAssign && (
            <span className="truncate text-[11px] text-muted-foreground">
              from the assigned agent
            </span>
          )}
        </p>
      </div>

      {/* Created by — a fact, stated once, and now stated *after* the two
          questions this section is opened to answer.

          It was the first thing in the card and occupied a full labelled row of
          its own, which gave the person who typed the order the same weight as
          the person who owns it. It is still kept visibly separate from the
          assignee, because they are different people whenever a supervisor or an
          administrator takes an order down and conflating them is what put
          non-agents into agent workload — but separate no longer has to mean
          equal. One quiet line under the pair it qualifies. */}
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-tight text-muted-foreground sm:col-span-2">
        <UserPen className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>Created by</span>
        <span className="truncate font-medium text-foreground">{creator?.full_name ?? "—"}</span>
        {creator?.agent_code && <span className="shrink-0 font-mono">{creator.agent_code}</span>}
      </p>
    </div>
  );
}
