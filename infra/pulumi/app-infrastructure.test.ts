import { describe, it, expect, beforeEach } from "vitest";
import * as pulumi from "@pulumi/pulumi";

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

let resources: Record<string, { type: string; inputs: Record<string, unknown> }> = {};

beforeEach(() => {
  resources = {};
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } => {
      resources[args.name] = {
        type: args.type,
        inputs: args.inputs,
      };

      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "gcp:serviceaccount/account:Account") {
        state.email = `${(args.inputs.accountId as string) || args.name}@mock-project.iam.gserviceaccount.com`;
      }
      if (args.type.includes("cloudrunv2/service:Service")) {
        state.uri = `https://${(args.inputs.name as string) || args.name}-mock.a.run.app`;
        state.name = args.inputs.name || args.name;
        state.location = args.inputs.location || "us-east4";
      }
      if (args.type.includes("artifactregistry/repository:Repository")) {
        state.name = `projects/mock-project/locations/${(args.inputs.location as string) || "us-east4"}/repositories/${(args.inputs.repositoryId as string) || args.name}`;
      }

      return {
        id: args.name + "_id",
        state,
      };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      return args.inputs;
    },
  });
});

describe("AppInfrastructure ComponentResource", () => {
  it("creates Artifact Registry, private Cloud Run v2 service, and dedicated invoker SA with IAM binding", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const infra = new AppInfrastructure("dev-infra", {
      projectId: "inc-io-docs-dev",
      region: "us-east4",
      repositoryName: "inc-io-docs",
      serviceName: "inc-io-docs-dev",
      invokerName: "addon-invoker",
      port: 8080,
    });

    const repoUrl = await promiseOf(infra.repositoryUrl);
    const serviceUrl = await promiseOf(infra.serviceUrl);
    const invokerEmail = await promiseOf(infra.invokerServiceAccountEmail);
    const iamMemberId = await promiseOf(infra.invokerIamMember.id);

    expect(repoUrl).toContain("us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs");
    expect(serviceUrl).toBe("https://inc-io-docs-dev-mock.a.run.app");
    expect(invokerEmail).toBe("addon-invoker@mock-project.iam.gserviceaccount.com");
    expect(iamMemberId).toBeDefined();

    // Check Artifact Registry repository resource
    const repoRes = Object.values(resources).find(
      (r) => r.type.includes("artifactregistry/repository:Repository")
    );
    expect(repoRes).toBeDefined();
    expect(repoRes?.inputs.format).toBe("DOCKER");
    expect(repoRes?.inputs.repositoryId).toBe("inc-io-docs");

    // Check Invoker Service Account resource
    const saRes = Object.values(resources).find(
      (r) => r.type.includes("serviceaccount/account:Account")
    );
    expect(saRes).toBeDefined();
    expect(saRes?.inputs.accountId).toBe("addon-invoker");

    // Check Cloud Run Service resource
    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service")
    );
    expect(runRes).toBeDefined();
    expect(runRes?.inputs.location).toBe("us-east4");
    expect(runRes?.inputs.name).toBe("inc-io-docs-dev");

    // Check IAM Binding for invoker
    const iamBindings = Object.values(resources).filter(
      (r) => r.type.includes("ServiceIamMember")
    );
    expect(iamBindings.length).toBe(2);

    const invokerIamRes = iamBindings.find(r => r.inputs.member === "serviceAccount:addon-invoker@mock-project.iam.gserviceaccount.com");
    expect(invokerIamRes).toBeDefined();
    expect(invokerIamRes?.inputs.role).toBe("roles/run.invoker");

    const workspaceIamRes = iamBindings.find(r => r.inputs.member === "serviceAccount:service-137115190443@gcp-sa-gsuiteaddons.iam.gserviceaccount.com");
    expect(workspaceIamRes).toBeDefined();
    expect(workspaceIamRes?.inputs.role).toBe("roles/run.invoker");

    // Verify NO public access (allUsers) IAM binding exists
    const publicAccessBinding = Object.values(resources).find(
      (r) =>
        r.type.includes("Iam") &&
        (r.inputs.member === "allUsers" || (r.inputs.members as string[])?.includes("allUsers"))
    );
    expect(publicAccessBinding).toBeUndefined();
  });
});
