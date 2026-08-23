"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

/** Modal de confirmation à la charte Regularlog (remplace window.confirm). */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Supprimer",
  cancelLabel = "Annuler",
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <span className={`modal-icon${danger ? " danger" : ""}`}>
            <AlertTriangle size={18} />
          </span>
          <h3 className="modal-title">{title}</h3>
        </div>
        <p className="modal-msg">{message}</p>
        <div className="modal-actions">
          <button className="btn secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn${danger ? " danger" : ""}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
