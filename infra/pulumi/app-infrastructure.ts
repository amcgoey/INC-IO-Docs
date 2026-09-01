import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface AppInfrastructureArgs {
  /**
   * GCP Project ID. Defaults to GCP provider project or 'inc-io-docs-dev'.
   */
  projectId?: pulumi.Input<string>;

  /**
   * GCP Region for Artifact Registry and Cloud Run. Defaults to 'us-east4'.
   */
  region?: pulumi.Input<string>;

  /**
   * Artifact Registry repository ID/name. Defaults to 'inc-io-docs'.
   */
  repositoryName?: pulumi.Input<string>;

  /**
   * Cloud Run service name. Defaults to 'inc-io-docs-dev'.
   */
  serviceName?: pulumi.Input<string>;

  /**
   * Dedicated invoker Service Account accountId. Defaults to 'addon-invoker'.
   */
  invokerName?: pulumi.Input<string>;

  /**
   * Container image to deploy on Cloud Run. Defaults to a standard hello/placeholder image or registry image.
   */
  image?: pulumi.Input<string>;

  /**
   * Port on which the container listens. Defaults to 8080.
   */
  port?: pulumi.Input<number>;
}

export class AppInfrastructure extends pulumi.ComponentResource {
  public readonly repository: gcp.artifactregistry.Repository;
  public readonly service: gcp.cloudrunv2.Service;
  public readonly invokerServiceAccount: gcp.serviceaccount.Account;
  public readonly invokerIamMember: gcp.cloudrunv2.ServiceIamMember;

  public readonly repositoryUrl: pulumi.Output<string>;
  public readonly serviceUrl: pulumi.Output<string>;
  public readonly invokerServiceAccountEmail: pulumi.Output<string>;

  constructor(name: string, args: AppInfrastructureArgs = {}, opts?: pulumi.ComponentResourceOptions) {
    super("custom:app:AppInfrastructure", name, {}, opts);

    const gcpConfig = new pulumi.Config("gcp");
    const projectId = args.projectId ?? gcpConfig.get("project") ?? "inc-io-docs-dev";
    const region = args.region ?? gcpConfig.get("region") ?? "us-east4";
    const repositoryName = args.repositoryName ?? "inc-io-docs";
    const serviceName = args.serviceName ?? name;
    const invokerName = args.invokerName ?? "addon-invoker";
    const port = args.port ?? 8080;
    const image = args.image ?? "us-docker.pkg.dev/cloudrun/container/hello";

    // 1. Enable required GCP APIs
    const requiredApis = [
      "artifactregistry.googleapis.com",
      "run.googleapis.com",
      "compute.googleapis.com",
      "drive.googleapis.com",
      "appsmarket.googleapis.com",
    ];

    const enabledApis = requiredApis.map(
      (api) =>
        new gcp.projects.Service(
          `${name}-${api.split(".")[0]}-api`,
          {
            service: api,
            disableOnDestroy: false,
            project: projectId,
          },
          { parent: this }
        )
    );

    // 2. Artifact Registry Docker Repository
    const repository = new gcp.artifactregistry.Repository(
      `${name}-repo`,
      {
        repositoryId: repositoryName,
        format: "DOCKER",
        location: region,
        project: projectId,
        description: "Docker repository for INC-IO-Docs application",
      },
      { parent: this, dependsOn: enabledApis }
    );

    // 3. Dedicated Workspace Add-on Invoker Service Account
    const invokerServiceAccount = new gcp.serviceaccount.Account(
      `${name}-invoker-sa`,
      {
        accountId: invokerName,
        displayName: "Dedicated Cloud Run Invoker for Workspace Add-on",
        project: projectId,
      },
      { parent: this }
    );

    // 4. Private Cloud Run Service (IAM-protected)
    const service = new gcp.cloudrunv2.Service(
      `${name}-service`,
      {
        name: serviceName,
        location: region,
        project: projectId,
        ingress: "INGRESS_TRAFFIC_ALL",
        template: {
          containers: [
            {
              image: image,
              ports: {
                containerPort: port,
              },
              resources: {
                limits: {
                  memory: "4Gi",
                  cpu: "2",
                },
              },
              envs: [
                {
                  name: "NODE_OPTIONS",
                  value: "--max-old-space-size=3584",
                },
              ],
            },
          ],
        },
      },
      { parent: this, dependsOn: enabledApis }
    );

    // 5. Dedicated IAM Binding: Grant roles/run.invoker to the invoker Service Account ONLY
    const invokerIamMember = new gcp.cloudrunv2.ServiceIamMember(
      `${name}-invoker-iam`,
      {
        name: service.name,
        location: service.location,
        project: projectId,
        role: "roles/run.invoker",
        member: pulumi.interpolate`serviceAccount:${invokerServiceAccount.email}`,
      },
      { parent: this }
    );

    // 6. Grant roles/run.invoker to the Google Workspace Add-ons system service account
    new gcp.cloudrunv2.ServiceIamMember(
      `${name}-workspace-iam`,
      {
        name: service.name,
        location: service.location,
        project: projectId,
        role: "roles/run.invoker",
        member: "serviceAccount:service-137115190443@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      },
      { parent: this }
    );

    this.repository = repository;
    this.service = service;
    this.invokerServiceAccount = invokerServiceAccount;
    this.invokerIamMember = invokerIamMember;

    this.repositoryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${projectId}/${repository.repositoryId}`;
    this.serviceUrl = service.uri;
    this.invokerServiceAccountEmail = invokerServiceAccount.email;

    this.registerOutputs({
      repositoryUrl: this.repositoryUrl,
      serviceUrl: this.serviceUrl,
      invokerServiceAccountEmail: this.invokerServiceAccountEmail,
    });
  }
}
