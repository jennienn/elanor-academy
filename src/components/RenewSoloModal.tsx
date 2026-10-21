"use client";
import { ProductPurchaseModal } from "./ProductPurchaseModal";
export function RenewSoloModal(props: { open: boolean; onClose: () => void; onSuccess: () => void; enrollmentId: string; memberName: string; currentRemain: number }) {
  return <ProductPurchaseModal {...props} title={props.memberName} initialKind="solo" />;
}
