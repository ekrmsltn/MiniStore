export type ConversationMessage = { role: 'user' | 'assistant'; content: string };

export interface AssistantContext {
  role: string;
  permissions: string[];
  knowledge: string[];
  activity: Record<string, number>;
  currentResources?: {
    activeCount: number;
    matchCount: number;
    truncated: boolean;
    items: Array<{
      resourceId: string;
      title: string;
      description: string;
      tags: string[];
      fileName: string;
      fileType: string;
      fileSize: number;
      category: string | null;
      folder: string;
      version: number;
      downloadCount: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  currentUsers?: {
    totalCount: number;
    truncated: boolean;
    items: Array<{
      reference: string;
      subject: 'current_caller' | 'configured_owner' | 'account';
      role?: string;
      status?: string;
      permissions?: string[];
      createdAt?: string;
    }>;
  };
}
