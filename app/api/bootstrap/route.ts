import { getMasterData, errorResponse, requireOrganization } from "@/lib/server";

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const context = await requireOrganization(organizationId);
    const master = await getMasterData(context.organizationId);
    return Response.json({
      user: {
        displayName: context.user.displayName,
        email: context.user.email,
      },
      organization: {
        id: context.organizationId,
        name: context.organizationName,
        role: context.role,
      },
      ...master,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
