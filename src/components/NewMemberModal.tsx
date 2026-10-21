"use client";
import { ProductPurchaseModal } from "./ProductPurchaseModal";
export function NewMemberModal(props: { open: boolean; onClose: () => void; onSuccess: (memberId: number) => void }) {
  return <ProductPurchaseModal {...props} title="회원 등록" />;
}
