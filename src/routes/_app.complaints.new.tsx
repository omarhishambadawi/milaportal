import { createFileRoute } from "@tanstack/react-router";
import { ComplaintForm } from "@/features/complaints/components/complaint-form";

export const Route = createFileRoute("/_app/complaints/new")({
  head: () => ({ meta: [{ title: "New Complaint" }] }),
  component: () => <ComplaintForm mode="create" />,
});
