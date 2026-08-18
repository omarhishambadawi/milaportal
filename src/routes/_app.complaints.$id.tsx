import { createFileRoute } from "@tanstack/react-router";
import { ComplaintForm } from "@/features/complaints/components/complaint-form";

export const Route = createFileRoute("/_app/complaints/$id")({
  head: () => ({ meta: [{ title: "Edit Complaint" }] }),
  component: () => <ComplaintForm mode="edit" />,
});
