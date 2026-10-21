"use client";
import { ProductPurchaseModal } from "./ProductPurchaseModal";
export function AddEnrollmentModal(props: { open: boolean; onClose: () => void; onSuccess: () => void; memberId: number; memberName?: string }) {
  return <ProductPurchaseModal {...props} title="수강권 추가" />;
}
