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
 * Owner and Admin. `isAdministrator` rather than a new permission: reassignment
 * is already governed by `edit_all_orders` in `prevent_order_reassignment`, and
 * this control is deliberately narrower than that rule rather than wider —
 * nothing here can grant an ability the database does not already allow. Agents
 * see who the order is assigned to and no control.
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, UserCog } from "lucide-react";
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

const teamLabel = (team: string) => TEAMS.find((t) => t.value === team)?.label ?? team;

export function OrderAssignment({
  agents,
  agentId,
  team,
  canAssign,
  disabled,
  onAssign,
}: {
  /** The shared agent directory; only operational roles are offered. */
  agents: DirectoryAgent[] | undefined;
  agentId: string | null | undefined;
  team: string;
  canAssign: boolean;
  disabled?: boolean;
  /** Receives both, because choosing the agent is what decides the team. */
  onAssign: (next: { agentId: string; team: OrderTeam | null }) => void;
}) {
  const [open, setOpen] = useState(false);

  /** Only the roles that can hold an order. An admin is not an order's agent. */
  const assignable = useMemo(
    () => (agents ?? []).filter((a) => teamForAgent(a) !== null),
    [agents],
  );

  const current = useMemo(() => agents?.find((a) => a.id === agentId), [agents, agentId]);
  const derivedTeam = teamForAgent(current) ?? (team || null);

  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium">Assigned agent</p>
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
                  <span className="text-muted-foreground">Select an agent…</span>
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
            <span className="truncate font-medium">{current?.full_name ?? "—"}</span>
            {current?.agent_code && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {current.agent_code}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium">Team</p>
        <p className="flex h-9 items-center gap-2 text-sm">
          <UserCog className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{derivedTeam ? teamLabel(derivedTeam) : "—"}</span>
          <span className="truncate text-xs text-muted-foreground">
            {canAssign ? "from the assigned agent" : ""}
          </span>
        </p>
      </div>
    </div>
  );
}
