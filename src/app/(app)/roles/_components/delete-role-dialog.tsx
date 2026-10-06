"use client";

import { useTransition } from "react";
import { Button, Modal, Spinner, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useRoleName } from "@/components/security/use-role-name";
import { useSecurityError } from "@/components/security/use-security-error";
import type { RoleSummary } from "@/types/auth";
import { deleteRoleAction } from "../_action";

export default function DeleteRoleDialog({
  state,
  role,
  onDeleted,
}: {
  state: ReturnType<typeof useOverlayState>;
  role: RoleSummary | null;
  onDeleted: (role: RoleSummary) => void;
}) {
  const t = useTranslations("Roles");
  const tCommon = useTranslations("Common");
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const [pending, start] = useTransition();

  function remove(close: () => void) {
    if (!role) return;
    start(async () => {
      const result = await deleteRoleAction(role.id);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onDeleted(role);
      toast(t("toasts.deleted"), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("deleteTitle")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p className="text-sm text-muted">
                    {t("deleteConfirm", { role: role ? roleName(role) : "" })}
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button variant="danger" isPending={pending} onPress={() => remove(close)}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {tCommon("delete")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
