import { int, json, mysqlEnum, mysqlTable, text, timestamp, unique, varchar } from "drizzle-orm/mysql-core";

export const accountRoleValues = ["user", "admin", "child", "teacher", "parent"] as const;
export type AccountRole = (typeof accountRoleValues)[number];
export const assessmentModeValues = ["GUIDED_PRACTICE", "ASSISTED_PRACTICE", "MONTHLY_ASSESSMENT"] as const;
export type AssessmentMode = (typeof assessmentModeValues)[number];
export const readingLanguageSupportValues = ["STANDARD_ENGLISH", "IRISH_ENGLISH_SUPPORT"] as const;
export type ReadingLanguageSupport = (typeof readingLanguageSupportValues)[number];
export const materialRightsSourceValues = ["original", "public_domain", "permission_obtained"] as const;
export type MaterialRightsSource = (typeof materialRightsSourceValues)[number];
export const materialLifecycleValues = ["draft", "teacher_approved", "assignable"] as const;
export type MaterialLifecycle = (typeof materialLifecycleValues)[number];

/** Core identity managed by Manus OAuth. Roles are assigned through the Reader Leader onboarding flow. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", accountRoleValues).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const readerClasses = mysqlTable("readerClasses", {
  id: int("id").autoincrement().primaryKey(),
  teacherUserId: int("teacherUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  joinCode: varchar("joinCode", { length: 12 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** A reusable, teacher-owned assessment-reporting range. Dates are stored as ISO calendar days. */
export const teacherTermPresets = mysqlTable("teacherTermPresets", {
  id: int("id").autoincrement().primaryKey(),
  teacherUserId: int("teacherUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  startDate: varchar("startDate", { length: 10 }).notNull(),
  endDate: varchar("endDate", { length: 10 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [unique("teacher_term_preset_name_unique").on(table.teacherUserId, table.name)]);

export const schoolBranding = mysqlTable("schoolBranding", {
  id: int("id").autoincrement().primaryKey(),
  teacherUserId: int("teacherUserId").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  schoolName: varchar("schoolName", { length: 120 }).notNull().default("Reader Leader School"),
  accentColor: varchar("accentColor", { length: 12 }).notNull().default("#2563EB"),
  footerLine: varchar("footerLine", { length: 180 }).notNull().default("Every reader can grow with practice and encouragement."),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const childProfiles = mysqlTable("childProfiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("displayName", { length: 80 }).notNull(),
  bookBand: varchar("bookBand", { length: 80 }).notNull().default("Level 3 · Sky Blue"),
  familyCode: varchar("familyCode", { length: 12 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Teacher-configured defaults and supportive pace target for one learner. */
export const learnerReadingSettings = mysqlTable("learnerReadingSettings", {
  id: int("id").autoincrement().primaryKey(),
  childProfileId: int("childProfileId").notNull().unique().references(() => childProfiles.id, { onDelete: "cascade" }),
  defaultReadingMode: mysqlEnum("defaultReadingMode", assessmentModeValues).notNull().default("ASSISTED_PRACTICE"),
  targetWcpm: int("targetWcpm").notNull().default(100),
  languageSupport: mysqlEnum("languageSupport", readingLanguageSupportValues).notNull().default("STANDARD_ENGLISH"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const classEnrollments = mysqlTable("classEnrollments", {
  id: int("id").autoincrement().primaryKey(),
  classId: int("classId").notNull().references(() => readerClasses.id, { onDelete: "cascade" }),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [unique("class_child_unique").on(table.classId, table.childProfileId)]);

export const familyLinks = mysqlTable("familyLinks", {
  id: int("id").autoincrement().primaryKey(),
  parentUserId: int("parentUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [unique("parent_child_unique").on(table.parentUserId, table.childProfileId)]);

/** One parent-managed, three-step home-practice checklist per linked learner and UTC calendar day. */
export const homePracticeChecklists = mysqlTable("homePracticeChecklists", {
  id: int("id").autoincrement().primaryKey(),
  parentUserId: int("parentUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  checklistDate: varchar("checklistDate", { length: 10 }).notNull(),
  completedSteps: json("completedSteps").$type<boolean[]>().notNull(),
  completedAt: timestamp("completedAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [unique("parent_child_practice_date_unique").on(table.parentUserId, table.childProfileId, table.checklistDate)]);

/** An in-app notification is created once when a linked parent completes a learner's daily checklist. */
export const parentReminders = mysqlTable("parentReminders", {
  id: int("id").autoincrement().primaryKey(),
  parentUserId: int("parentUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  checklistId: int("checklistId").notNull().unique().references(() => homePracticeChecklists.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 160 }).notNull(),
  message: varchar("message", { length: 360 }).notNull(),
  status: mysqlEnum("status", ["unread", "read"]).notNull().default("unread"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  readAt: timestamp("readAt"),
});

export const readingMaterials = mysqlTable("readingMaterials", {
  id: int("id").autoincrement().primaryKey(),
  teacherUserId: int("teacherUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 180 }).notNull(),
  readingLevel: varchar("readingLevel", { length: 80 }).notNull(),
  sourceText: text("sourceText").notNull(),
  sourceFilename: varchar("sourceFilename", { length: 255 }),
  storageKey: varchar("storageKey", { length: 512 }),
  status: mysqlEnum("status", ["draft", "assigned"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Breadth-layer metadata and approval state for teacher-contributed texts. */
export const readingMaterialDetails = mysqlTable("readingMaterialDetails", {
  id: int("id").autoincrement().primaryKey(),
  materialId: int("materialId").notNull().unique().references(() => readingMaterials.id, { onDelete: "cascade" }),
  author: varchar("author", { length: 180 }).notNull(),
  rightsSource: mysqlEnum("rightsSource", materialRightsSourceValues).notNull(),
  interestAge: varchar("interestAge", { length: 80 }).notNull(),
  genre: varchar("genre", { length: 80 }).notNull(),
  lifecycleStatus: mysqlEnum("lifecycleStatus", materialLifecycleValues).default("draft").notNull(),
  approvedByUserId: int("approvedByUserId").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approvedAt"),
  assignableAt: timestamp("assignableAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ExerciseQuestion = { prompt: string; options: string[]; answer: string; explanation: string };
export type ExerciseSet = { vocabulary: { word: string; childFriendlyMeaning: string }[]; questions: ExerciseQuestion[]; activity: string };

export const readingExercises = mysqlTable("readingExercises", {
  id: int("id").autoincrement().primaryKey(),
  materialId: int("materialId").notNull().unique().references(() => readingMaterials.id, { onDelete: "cascade" }),
  exerciseSet: json("exerciseSet").$type<ExerciseSet>().notNull(),
  modelName: varchar("modelName", { length: 80 }).notNull(),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const materialAssignments = mysqlTable("materialAssignments", {
  id: int("id").autoincrement().primaryKey(),
  classId: int("classId").notNull().references(() => readerClasses.id, { onDelete: "cascade" }),
  materialId: int("materialId").notNull().references(() => readingMaterials.id, { onDelete: "cascade" }),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
}, table => [unique("assigned_material_class_unique").on(table.classId, table.materialId)]);

export type StoredIntervention = { word: string; action: "prompt" | "model" | "stay_silent" | "teacher_review"; note: string };
export type StoredWordState = { id: string; text: string; status: "unread" | "current" | "correct" | "incorrect" | "retried_correct"; attempts: number };
export type StoredWordTiming = { id: string; text: string; startMs: number; endMs: number };

export const readingSessions = mysqlTable("readingSessions", {
  id: int("id").autoincrement().primaryKey(),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  materialId: int("materialId").references(() => readingMaterials.id, { onDelete: "set null" }),
  storyTitle: varchar("storyTitle", { length: 180 }).notNull(),
  transcript: text("transcript").notNull(),
  accuracy: int("accuracy").notNull(),
  wordsCorrectPerMinute: int("wordsCorrectPerMinute").notNull(),
  durationSeconds: int("durationSeconds").notNull(),
  audioStorageKey: varchar("audioStorageKey", { length: 512 }),
  completed: int("completed").notNull().default(1),
  assessmentMode: mysqlEnum("assessmentMode", assessmentModeValues).notNull().default("ASSISTED_PRACTICE"),
  languageSupport: mysqlEnum("languageSupport", readingLanguageSupportValues).notNull().default("STANDARD_ENGLISH"),
  practiceWords: json("practiceWords").$type<string[]>().notNull(),
  interventions: json("interventions").$type<StoredIntervention[]>().notNull(),
  wordStates: json("wordStates").$type<StoredWordState[]>().notNull(),
  wordTimings: json("wordTimings").$type<StoredWordTiming[]>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const sessionComments = mysqlTable("sessionComments", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull().references(() => readingSessions.id, { onDelete: "cascade" }),
  teacherUserId: int("teacherUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
  comment: text("comment").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type QuizAnswer = { questionIndex: number; selectedAnswer: string; correct: boolean };

export const quizAttempts = mysqlTable("quizAttempts", {
  id: int("id").autoincrement().primaryKey(),
  childProfileId: int("childProfileId").notNull().references(() => childProfiles.id, { onDelete: "cascade" }),
  materialId: int("materialId").notNull().references(() => readingMaterials.id, { onDelete: "cascade" }),
  answers: json("answers").$type<QuizAnswer[]>().notNull(),
  score: int("score").notNull(),
  totalQuestions: int("totalQuestions").notNull(),
  completedAt: timestamp("completedAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type ReadingMaterial = typeof readingMaterials.$inferSelect;
export type ReadingMaterialDetails = typeof readingMaterialDetails.$inferSelect;
export type ReadingSession = typeof readingSessions.$inferSelect;
