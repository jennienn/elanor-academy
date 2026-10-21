"use client";
import { ProductPurchaseModal } from "./ProductPurchaseModal";
export function RenewGroupModal(props: { open: boolean; onClose: () => void; onSuccess: () => void; enrollmentId: string; memberName: string; className: string; classId: number }) {
  return <ProductPurchaseModal {...props} title={props.memberName} initialKind="group" />;
}
