export interface CheckCardItem {
  check: string;
  passed: boolean;
  detail: string;
}

export interface ComponentCardItem {
  component: string;
  weight: number;
  fraction: number;
  points: number;
  detail: string;
}

export interface QualityCardSection {
  score: number;
  label: string;
  components: ComponentCardItem[];
}

export interface ConstitutionCardSection {
  checks: CheckCardItem[];
}

export interface PortfolioRiskCardSection {
  checks: CheckCardItem[];
}

export interface DailyBudgetCardSection {
  checks: CheckCardItem[];
}

export interface DecisionCardSection {
  status: "APPROVED" | "REJECTED";
  evaluated_at: string;
  expires_at: string;
  session: string;
}

export interface PermitCardApproved {
  permit_id: string;
  quality: QualityCardSection;
  constitution: ConstitutionCardSection;
  portfolio_risk: PortfolioRiskCardSection;
  daily_budget: DailyBudgetCardSection;
  decision: DecisionCardSection;
}

export interface PermitCardRejected {
  permit_id: string;
  decision: DecisionCardSection;
  reasons: string[];
}

export type PermitResponse = PermitCardApproved | PermitCardRejected;

export interface PermitIssuedEnvelope {
  data: PermitResponse;
  permit_id: string;
  meta: null;
  error: null;
}
