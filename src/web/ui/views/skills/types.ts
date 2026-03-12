export interface SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillDetail extends SkillInfo {
  readonly content: string;
  readonly body: string;
}

export interface SkillsResponse {
  readonly success: boolean;
  readonly data: SkillInfo[];
}

export interface SkillDetailResponse {
  readonly success: boolean;
  readonly data: SkillDetail;
}

export interface SkillFormData {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    id: "blank",
    name: "Blank Skill",
    description: "Start from scratch",
    content: "",
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review code for quality, security, and best practices",
    content: `# Code Review Skill

## Objective
Review code changes for quality, security, and adherence to best practices.

## Steps
1. Analyze the code diff or file contents
2. Check for common issues:
   - Security vulnerabilities (injection, XSS, etc.)
   - Performance bottlenecks
   - Code style violations
   - Missing error handling
3. Provide actionable feedback with specific line references
4. Suggest improvements with code examples

## Output Format
- **Critical**: Must fix before merge
- **Warning**: Should fix, potential issues
- **Suggestion**: Nice to have improvements`,
  },
  {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Analyze datasets and generate insights",
    content: `# Data Analysis Skill

## Objective
Analyze provided data and generate meaningful insights.

## Steps
1. Understand the data structure and types
2. Identify key metrics and trends
3. Look for patterns, anomalies, and correlations
4. Generate visualizations if applicable
5. Summarize findings with actionable recommendations

## Guidelines
- Always validate data quality first
- Use statistical methods where appropriate
- Present findings in clear, non-technical language
- Include confidence levels for predictions`,
  },
  {
    id: "api-design",
    name: "API Design",
    description: "Design RESTful API endpoints following best practices",
    content: `# API Design Skill

## Objective
Design clean, consistent RESTful API endpoints.

## Principles
- Use resource-oriented URLs
- Apply proper HTTP methods (GET, POST, PUT, DELETE)
- Version APIs appropriately
- Include pagination for list endpoints
- Use consistent error response format

## Template
\`\`\`
GET    /api/v1/{resources}          - List
GET    /api/v1/{resources}/:id      - Get detail
POST   /api/v1/{resources}          - Create
PUT    /api/v1/{resources}/:id      - Update
DELETE /api/v1/{resources}/:id      - Delete
\`\`\`

## Error Format
\`\`\`json
{
  "success": false,
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
\`\`\``,
  },
  {
    id: "writing",
    name: "Content Writing",
    description: "Write clear, engaging content for various formats",
    content: `# Content Writing Skill

## Objective
Create clear, engaging, and well-structured content.

## Guidelines
- Start with a compelling hook
- Use short paragraphs and sentences
- Include relevant examples
- Maintain consistent tone and voice
- End with a clear call-to-action or summary

## Formats Supported
- Blog posts
- Documentation
- Social media
- Email campaigns
- Technical guides`,
  },
] as const;

export interface SkillTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
}
