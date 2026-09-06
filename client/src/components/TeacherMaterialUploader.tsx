import { trpc } from "@/lib/trpc";
import { FileText, Upload } from "lucide-react";
import { ChangeEvent, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type MaterialRightsSource = "original" | "public_domain" | "permission_obtained";

function toBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return window.btoa(binary);
}

export function TeacherMaterialUploader() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [rightsSource, setRightsSource] = useState<MaterialRightsSource>("original");
  const [interestAge, setInterestAge] = useState("8–10");
  const [genre, setGenre] = useState("");
  const [level, setLevel] = useState("Level 3 · Sky Blue");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [fileBase64, setFileBase64] = useState<string | undefined>();
  const [fileMime, setFileMime] = useState("text/plain");
  const [storageKey, setStorageKey] = useState<string | undefined>();
  const [extractionNotice, setExtractionNotice] = useState("");
  const extract = trpc.readerLeader.materials.extractUpload.useMutation({
    onSuccess: data => {
      setText(data.text);
      setStorageKey(data.storageKey);
      setFileBase64(undefined);
      setExtractionNotice(`${data.sourceType.toUpperCase()} text extracted and ready for your review${data.truncated ? " (preview shortened to 8,000 characters)" : ""}.`);
    },
    onError: error => toast(error.message),
  });
  const create = trpc.readerLeader.materials.create.useMutation({
    onSuccess: async data => {
      await utils.readerLeader.materials.listMine.invalidate();
      await utils.readerLeader.dashboards.teacher.invalidate();
      setLocation(`/teacher/materials/${data.id}/review`);
    },
    onError: error => toast(error.message),
  });

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) return toast("Choose a PDF, DOCX, or text file under 5 MB.");
    const extension = file.name.toLowerCase().split(".").pop();
    if (!(["pdf", "docx", "txt"].includes(extension || ""))) return toast("Use a PDF, DOCX, or plain-text passage.");
    const mime = file.type || (extension === "pdf" ? "application/pdf" : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain");
    const base64 = toBase64(await file.arrayBuffer());
    setFilename(file.name);
    setFileMime(mime);
    setFileBase64(base64);
    setStorageKey(undefined);
    setExtractionNotice("Extracting the passage for your review…");
    extract.mutate({ sourceFilename: file.name, sourceFileBase64: base64, sourceFileMime: mime });
  };

  const save = () => {
    if (title.trim().length < 3 || author.trim().length < 2 || genre.trim().length < 2 || interestAge.trim().length < 2 || text.trim().length < 80) {
      return toast("Add the title, author, interest age, genre, rights source, and reading passage before saving.");
    }
    create.mutate({
      title,
      author,
      rightsSource,
      interestAge,
      genre,
      readingLevel: level,
      sourceText: text,
      sourceFilename: filename || undefined,
      sourceFileBase64: storageKey ? undefined : fileBase64,
      sourceFileMime: fileMime,
      storageKey,
    });
  };

  return <section className="material-lab material-uploader"><div className="material-head"><div><div className="kicker">Lesson resources</div><h2>Create a reading-text draft.</h2><p>Paste a child-appropriate text, record its source details, and save it as a draft. You will review and approve it before choosing any classes.</p></div><span className="view-chip">Draft first</span></div><div className="material-form full-width"><label>Reading material title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. The Lantern in the Garden" /></label><div className="field-grid"><label>Author<input value={author} onChange={event => setAuthor(event.target.value)} placeholder="e.g. Ms Kelly" /></label><label>Rights / source<select value={rightsSource} onChange={event => setRightsSource(event.target.value as MaterialRightsSource)}><option value="original">Original</option><option value="public_domain">Public domain</option><option value="permission_obtained">Permission obtained</option></select></label></div><div className="field-grid"><label>Interest age<input value={interestAge} onChange={event => setInterestAge(event.target.value)} placeholder="e.g. 8–10" /></label><label>Genre<input value={genre} onChange={event => setGenre(event.target.value)} placeholder="e.g. Adventure" /></label></div><div className="field-grid"><label>Reading level<select value={level} onChange={event => setLevel(event.target.value)}><option>Level 3 · Sky Blue</option><option>Level 4 · Gold</option><option>Level 5 · Green</option></select></label><label className="file-input">Optional source file<input type="file" accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => void loadFile(event)} /><span><Upload size={15} /> {filename || "PDF, DOCX, or .txt"}</span></label></div><label>Reading text<textarea value={text} onChange={event => setText(event.target.value)} placeholder="Paste a child-appropriate passage here…" rows={11} /></label>{extractionNotice && <p className="extraction-note"><FileText size={14} /> {extractionNotice}</p>}<div className="form-actions"><button className="primary-cta" onClick={save} disabled={create.isPending || extract.isPending}><FileText size={16} /> {create.isPending ? "Saving draft…" : "Save as draft"}</button></div></div></section>;
}
