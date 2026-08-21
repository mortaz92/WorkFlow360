export interface PublicCorrection {
  id: string;
  taskId: string;
  reportedBy: string;
  description: string;
  status: 'open' | 'in_review' | 'approved' | 'rejected' | 'applied';
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: Date;
}

export interface CreateCorrectionInput {
  taskId: string;
  reportedBy: string;
  description: string;
  status?: 'open' | 'in_review' | 'approved' | 'rejected' | 'applied';
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface UpdateCorrectionInput {
  description?: string;
  status?: 'open' | 'in_review' | 'approved' | 'rejected' | 'applied';
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface PaginatedCorrections {
  corrections: PublicCorrection[];
  total: number;
  page: number;
  limit: number;
}
