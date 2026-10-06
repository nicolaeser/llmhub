"use client";

import { useRef } from "react";
import { Button, Separator, Spinner, TextArea, toast } from "@heroui/react";
import { ImagePlus, Send } from "lucide-react";
import { useTranslations } from "next-intl";

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.readAsDataURL(file);
  });
}

export default function ChatComposer({
  input,
  images,
  pending,
  canSend,
  onInputChange,
  onAddImages,
  onRemoveImage,
  onSend,
}: {
  input: string;
  images: string[];
  pending: boolean;
  canSend: boolean;
  onInputChange: (value: string) => void;
  onAddImages: (urls: string[]) => void;
  onRemoveImage: (index: number) => void;
  onSend: () => void;
}) {
  const t = useTranslations("Playground");
  const imageInput = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    try {
      const urls: string[] = [];
      for (const file of list) {
        const url = await readDataUrl(file);
        if (url) urls.push(url);
      }
      if (urls.length) onAddImages(urls);
    } catch {
      toast.danger(t("error"));
    }
  }

  return (
    <>
      {images.length ? (
        <>
          <Separator />
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="text-xs text-muted">
              {t("imageCount", { count: images.length })}
            </span>
            {images.map((_, i) => (
              <Button
                key={i}
                size="sm"
                variant="ghost"
                aria-label={t("removeImage")}
                onPress={() => onRemoveImage(i)}
              >
                {t("imageMarker")}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      <Separator />
      <form
        className="flex gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        aria-label={t("send")}
      >
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          onChange={(e) => {
            const files = e.currentTarget.files;
            e.currentTarget.value = "";
            void addFiles(files);
          }}
        />
        <Button
          isIconOnly
          variant="ghost"
          aria-label={t("attachImage")}
          isDisabled={pending}
          onPress={() => imageInput.current?.click()}
        >
          <ImagePlus size={16} aria-hidden />
        </Button>
        <TextArea
          aria-label={t("placeholder")}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={t("placeholder")}
          className="min-h-12 flex-1"
        />
        <Button
          type="submit"
          isPending={pending}
          isDisabled={!canSend}
          aria-label={t("send")}
        >
          {({ isPending }) =>
            isPending ? <Spinner size="sm" color="current" /> : <Send size={16} aria-hidden />
          }
        </Button>
      </form>
    </>
  );
}
