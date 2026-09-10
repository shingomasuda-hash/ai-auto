import { NextResponse } from 'next/server';
import { withOwner, readJson, badRequest } from '../../../lib/api.ts';
import { getSettings, updateSettings } from '../../../db/settings.ts';

export const GET = withOwner(async (user) => {
  const settings = await getSettings(user.id);
  return NextResponse.json({ settings });
});

export const POST = withOwner(async (user, request) => {
  const payload = await readJson(request);
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  const nonNegativeInt = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

  const recipients = Array.isArray(payload.allowedTestRecipients)
    ? payload.allowedTestRecipients.filter((v): v is string => typeof v === 'string')
    : undefined;

  const budget = nonNegativeInt(payload.monthlyBudgetYen);
  if (payload.monthlyBudgetYen !== undefined && budget === undefined) {
    return badRequest(['運営費上限は0以上の整数(円)で入力してください。']);
  }
  const goal = nonNegativeInt(payload.monthlyGoalYen);
  if (payload.monthlyGoalYen !== undefined && goal === undefined) {
    return badRequest(['利益目標は0以上の整数(円)で入力してください。']);
  }

  const settings = await updateSettings(user.id, {
    global_stop: bool(payload.globalStop),
    threads_stop: bool(payload.threadsStop),
    x_stop: bool(payload.xStop),
    email_stop: bool(payload.emailStop),
    ai_generation_enabled: bool(payload.aiGenerationEnabled),
    auto_approve_enabled: bool(payload.autoApproveEnabled),
    ai_model: typeof payload.aiModel === 'string' ? payload.aiModel : undefined,
    monthly_budget_yen: budget,
    monthly_goal_yen: goal,
    email_test_mode: bool(payload.emailTestMode),
    allowed_test_recipients: recipients,
  });

  return NextResponse.json({ settings });
});
