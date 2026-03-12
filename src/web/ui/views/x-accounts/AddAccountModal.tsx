import { useState } from "react";
import { z } from "zod";
import { Modal, Button, Input, FormField } from "../../components";
import { useZodForm } from "../../hooks/useZodForm";
import { apiFetch } from "../../api";
import type { AccountResponse } from "./types";

const addAccountSchema = z.object({
  label: z.string().max(100).optional(),
  authToken: z.string().min(1, "Auth Token is required"),
  ct0: z.string().min(1, "CT0 is required"),
});

type AddAccountValues = z.infer<typeof addAccountSchema>;

interface AddAccountModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

export function AddAccountModal({ open, onClose, onCreated }: AddAccountModalProps) {
  const [apiError, setApiError] = useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useZodForm(addAccountSchema, {
    defaultValues: { label: "", authToken: "", ct0: "" },
  });

  function handleClose() {
    reset();
    setApiError("");
    onClose();
  }

  async function onSubmit(values: AddAccountValues) {
    setApiError("");
    try {
      await apiFetch<AccountResponse>("/api/x/accounts", {
        method: "POST",
        body: JSON.stringify({
          label: values.label?.trim() || undefined,
          auth_token: values.authToken.trim(),
          ct0: values.ct0.trim(),
        }),
      });
      reset();
      onCreated();
      onClose();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setApiError(apiErr.message ?? "Failed to create account");
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add X Account">
      <form onSubmit={handleSubmit(onSubmit)}>
        {apiError && (
          <p className="text-danger text-sm mb-4">{apiError}</p>
        )}

        <div className="flex flex-col gap-4">
          <FormField label="Label (optional)" id="label">
            <Input
              id="label"
              type="text"
              {...register("label")}
              placeholder="e.g. Main Account, Brand Account..."
              maxLength={100}
            />
          </FormField>
          <FormField label="Auth Token" id="authToken" error={errors.authToken} hint="Find this in browser DevTools > Application > Cookies > x.com">
            <Input
              id="authToken"
              type="password"
              {...register("authToken")}
              placeholder="Paste auth_token cookie value..."
              autoComplete="off"
            />
          </FormField>
          <FormField label="CT0" id="ct0" error={errors.ct0}>
            <Input
              id="ct0"
              type="password"
              {...register("ct0")}
              placeholder="Paste ct0 cookie value..."
              autoComplete="off"
            />
          </FormField>
        </div>

        <div className="flex gap-2 mt-6">
          <Button type="submit" size="sm" loading={isSubmitting}>
            {isSubmitting ? "Adding..." : "Add Account"}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
