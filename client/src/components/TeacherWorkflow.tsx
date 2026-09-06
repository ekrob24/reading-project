import { trpc } from "@/lib/trpc";
import { ArrowLeft, BookOpen, Check, ClipboardCheck, FileText, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

const lifecycleLabels: Record<string, string> = {
  draft: "Draft",
  teacher_approved: "Teacher approved",
  assignable: "Assignable",
};

const rightsLabels: Record<string, string> = {
  original: "Original",
  public_domain: "Public domain",
  permission_obtained: "Permission obtained",
};

function ExerciseDocument({ exercise }: { exercise: any }) {
  return <section className="exercise-document"><div className="exercise-document-head"><div><div className="kicker">AI exercise draft · teacher review</div><h2>{exercise.activity}</h2><p>Review language, answers, and activity before assigning this material to children.</p></div><span className="view-chip">Draft for review</span></div><section className="exercise-section"><h3>Key vocabulary</h3><div className="vocabulary-grid">{exercise.vocabulary.map((item: any) => <article key={item.word} className="vocabulary-card"><strong>{item.word}</strong><p>{item.childFriendlyMeaning}</p></article>)}</div></section><section className="exercise-section question-document"><h3>Comprehension questions</h3><div className="question-document-list">{exercise.questions.map((question: any, index: number) => <article key={question.prompt}><p className="question-prompt"><b>{index + 1}.</b> {question.prompt}</p><div className="preview-options">{question.options.map((option: string, optionIndex: number) => <label key={option}><input type="radio" name={`preview-question-${index}`} disabled /><span>{String.fromCharCode(65 + optionIndex)}</span>{option}</label>)}</div><p className="answer-note"><b>Teacher answer:</b> {question.answer}</p></article>)}</div></section></section>;
}

function LifecycleSteps({ status }: { status: string }) {
  const statuses = ["draft", "teacher_approved", "assignable"];
  const activeIndex = Math.max(0, statuses.indexOf(status));
  return <ol className="material-lifecycle" aria-label="Material lifecycle">{statuses.map((item, index) => <li key={item} className={index <= activeIndex ? "complete" : ""}><span>{index + 1}</span><b>{lifecycleLabels[item]}</b></li>)}</ol>;
}

export function MaterialReviewScreen({ materialId }: { materialId: number }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const review = trpc.readerLeader.materials.review.useQuery({ materialId });
  const [generated, setGenerated] = useState<any>(null);
  const [selectedClassIds, setSelectedClassIds] = useState<number[]>([]);

  useEffect(() => {
    if (review.data) setSelectedClassIds(review.data.assignedClassIds);
  }, [review.dataUpdatedAt]);

  const refreshMaterial = async () => {
    await utils.readerLeader.materials.review.invalidate({ materialId });
    await utils.readerLeader.materials.listMine.invalidate();
    await utils.readerLeader.dashboards.teacher.invalidate();
  };

  const generate = trpc.readerLeader.materials.generateExercises.useMutation({
    onSuccess: async data => {
      setGenerated(data.exercise.exerciseSet);
      await refreshMaterial();
      toast("AI activities are ready for your review.");
    },
    onError: error => toast(error.message),
  });
  const approve = trpc.readerLeader.materials.approve.useMutation({
    onSuccess: async () => {
      await refreshMaterial();
      toast("Text approved. Complete the next step to make it assignable.");
    },
    onError: error => toast(error.message),
  });
  const makeAssignable = trpc.readerLeader.materials.makeAssignable.useMutation({
    onSuccess: async () => {
      await refreshMaterial();
      toast("This approved text is now ready for class assignment.");
    },
    onError: error => toast(error.message),
  });
  const assign = trpc.readerLeader.materials.assign.useMutation({
    onSuccess: async data => {
      window.sessionStorage.setItem("reader-leader-assignment", JSON.stringify({ materialId, assignedClasses: data.assignedClasses }));
      await refreshMaterial();
      setLocation("/teacher/assignments/confirmation");
    },
    onError: error => toast(error.message),
  });

  if (review.isLoading) return <div className="workflow-page"><div className="workflow-card">Loading your saved material…</div></div>;
  if (!review.data) return <div className="workflow-page"><section className="workflow-card"><h1>Material not found</h1><p>This material is unavailable, or belongs to another teacher account.</p><button className="secondary-cta" onClick={() => setLocation("/")}><ArrowLeft size={16} /> Return to Dashboard</button></section></div>;

  const material = review.data.material;
  const details = review.data.details;
  const exercise = generated ?? review.data.exercise?.exerciseSet;
  const lifecycleStatus = details?.lifecycleStatus ?? "legacy";
  const toggleClass = (classId: number) => setSelectedClassIds(current => current.includes(classId) ? current.filter(id => id !== classId) : [...current, classId]);

  return <main className="workflow-page"><section className="workflow-hero success"><div><div className="kicker"><Check size={15} /> Saved resource</div><h1>Review before assigning.</h1><p><b>{material.title}</b> is saved as a teacher-owned resource. Confirm the text and source details, approve it, then choose exactly which classes should receive it.</p></div><div className="workflow-actions"><button className="secondary-cta" onClick={() => generate.mutate({ materialId })} disabled={generate.isPending}><WandSparkles size={17} /> {generate.isPending ? "Generating…" : exercise ? "Regenerate exercises" : "Generate exercises"}</button><button className="secondary-cta" onClick={() => setLocation("/")}><ArrowLeft size={17} /> Return to Dashboard</button></div></section>{details ? <LifecycleSteps status={details.lifecycleStatus} /> : <section className="workflow-card legacy-material-note"><h2>Existing library material</h2><p>This material predates the required source metadata workflow. It remains available where already assigned, but new P0.1 approval requires a material created with author, rights/source, interest age, and genre.</p></section>}<section className="material-preview-document"><div className="card-title-row"><h2>{material.title}</h2><span>{material.readingLevel}</span></div>{details && <div className="material-metadata"><span><b>Author</b>{details.author}</span><span><b>Rights / source</b>{rightsLabels[details.rightsSource]}</span><span><b>Interest age</b>{details.interestAge}</span><span><b>Genre</b>{details.genre}</span></div>}<p>{material.sourceText}</p></section>{exercise ? <ExerciseDocument exercise={exercise} /> : <section className="workflow-empty"><WandSparkles size={34} /><h2>Optional comprehension activities</h2><p>The reading text can move through approval without AI exercises. Generate a draft only if you want vocabulary and comprehension activities to review too.</p></section>}{details && lifecycleStatus === "draft" && <section className="workflow-footer"><div><h2>Step 1: teacher approval</h2><p>Confirm that the text is age-appropriate and that its author and rights/source details are accurate.</p></div><button className="primary-cta" onClick={() => approve.mutate({ materialId })} disabled={approve.isPending}><Check size={17} /> {approve.isPending ? "Approving…" : "Approve text"}</button></section>}{details && lifecycleStatus === "teacher_approved" && <section className="workflow-footer"><div><h2>Step 2: make assignable</h2><p>The text is teacher approved. Mark it assignable before selecting any classes.</p></div><button className="primary-cta" onClick={() => makeAssignable.mutate({ materialId })} disabled={makeAssignable.isPending}><ClipboardCheck size={17} /> {makeAssignable.isPending ? "Updating…" : "Make assignable"}</button></section>}{details && lifecycleStatus === "assignable" && <section className="workflow-card class-assignment-panel"><div><div className="kicker">Step 3 · selected classes</div><h2>Choose who receives this text.</h2><p>Only checked classes will see the material in their child reading libraries.</p></div>{review.data.availableClasses.length ? <div className="assignment-class-list">{review.data.availableClasses.map(readerClass => <label key={readerClass.id}><input type="checkbox" checked={selectedClassIds.includes(readerClass.id)} onChange={() => toggleClass(readerClass.id)} /><span><b>{readerClass.name}</b><small>{readerClass.joinCode}</small></span></label>)}</div> : <p className="empty-card">Create a class before assigning this text.</p>}<button className="primary-cta" onClick={() => assign.mutate({ materialId, classIds: selectedClassIds })} disabled={!selectedClassIds.length || assign.isPending}><Check size={17} /> {assign.isPending ? "Assigning…" : `Assign to ${selectedClassIds.length || 0} selected ${selectedClassIds.length === 1 ? "class" : "classes"}`}</button></section>}</main>;
}

export function AssignmentConfirmationScreen() {
  const [, setLocation] = useLocation();
  const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem("reader-leader-assignment");
  const assignment = raw ? JSON.parse(raw) as { materialId: number; assignedClasses: { id: number; name: string; joinCode: string }[] } : { materialId: 0, assignedClasses: [] };
  return <main className="workflow-page"><section className="workflow-card confirmation-card"><span className="confirmation-icon"><ClipboardCheck size={34} /></span><div className="kicker">Assignment confirmed</div><h1>Your reading text is ready.</h1><p>The approved material is now available only to learners enrolled in the selected classes.</p><div className="confirmation-details"><div><b>Assigned classes</b>{assignment.assignedClasses.length ? assignment.assignedClasses.map(item => <span key={item.id}>{item.name}</span>) : <span>No classes selected</span>}</div><div><b>Class share codes</b>{assignment.assignedClasses.length ? assignment.assignedClasses.map(item => <span key={item.id} className="share-code">{item.joinCode}</span>) : <span>Available from your dashboard</span>}</div></div><button className="primary-cta" onClick={() => setLocation("/")}><BookOpen size={17} /> Return to Teacher Dashboard</button></section></main>;
}
