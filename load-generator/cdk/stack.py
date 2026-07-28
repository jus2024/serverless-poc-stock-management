"""CDK Stack for EC2-based DynamoDB load generator."""

import os

import aws_cdk as cdk
from aws_cdk import (
    CfnOutput,
    Stack,
    aws_ec2 as ec2,
    aws_iam as iam,
)
from constructs import Construct


class LoadGeneratorStack(Stack):
    """EC2 load generator stack for DynamoDB hot partition demonstration.

    Deploys a t3.xlarge EC2 instance with:
    - IAM role for DynamoDB writes and SSM Session Manager access
    - Security Group with outbound-only traffic (no inbound)
    - User Data that installs Python 3.12, boto3, and embeds the load test script
    - Table names passed via CDK context and written to /etc/environment
    """

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # --- Context parameters ---
        bad_table = self.node.try_get_context("badTable") or "kiro-roasters-inventory-bad"
        good_table = self.node.try_get_context("goodTable") or "kiro-roasters-inventory-good"

        # --- VPC (default) ---
        vpc = ec2.Vpc.from_lookup(self, "DefaultVpc", is_default=True)

        # --- Security Group (outbound only, no inbound) ---
        security_group = ec2.SecurityGroup(
            self,
            "LoadGenSG",
            vpc=vpc,
            description="Load generator - outbound only (SSM access, no inbound needed)",
            allow_all_outbound=True,
        )

        # --- IAM Role ---
        role = iam.Role(
            self,
            "LoadGenRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            description="IAM role for EC2 load generator (DynamoDB + SSM)",
        )

        # SSM Session Manager access
        role.add_managed_policy(
            iam.ManagedPolicy.from_aws_managed_policy_name("AmazonSSMManagedInstanceCore")
        )

        # DynamoDB write permissions (scoped to inventory tables)
        role.add_to_policy(
            iam.PolicyStatement(
                effect=iam.Effect.ALLOW,
                actions=[
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:Scan",
                    "dynamodb:GetItem",
                ],
                resources=["arn:aws:dynamodb:*:*:table/kiro-roasters-inventory-*"],
            )
        )

        # --- User Data ---
        user_data = ec2.UserData.for_linux()

        # Read load_test.py script content to embed via heredoc
        script_path = os.path.join(os.path.dirname(__file__), "..", "scripts", "load_test.py")
        with open(script_path, "r") as f:
            script_content = f.read()

        user_data.add_commands(
            # Install Python 3.12 and pip
            "dnf install -y python3.12 python3.12-pip",
            # Create load test directory
            "mkdir -p /opt/load-test",
            # Write table names to /etc/environment for easy access
            f'echo "BAD_TABLE={bad_table}" >> /etc/environment',
            f'echo "GOOD_TABLE={good_table}" >> /etc/environment',
            # Install boto3
            "pip3.12 install boto3",
            # Write the load test script via heredoc
            f"cat << 'LOAD_TEST_SCRIPT_EOF' > /opt/load-test/load_test.py\n{script_content}\nLOAD_TEST_SCRIPT_EOF",
            # Make script executable
            "chmod +x /opt/load-test/load_test.py",
        )

        # --- EC2 Instance ---
        instance = ec2.Instance(
            self,
            "LoadGenInstance",
            instance_type=ec2.InstanceType("t3.xlarge"),
            machine_image=ec2.MachineImage.latest_amazon_linux2023(),
            vpc=vpc,
            security_group=security_group,
            role=role,
            user_data=user_data,
        )

        # --- Outputs ---
        CfnOutput(
            self,
            "InstanceId",
            value=instance.instance_id,
            description="EC2 Instance ID (use with SSM Session Manager)",
        )
        CfnOutput(
            self,
            "SSMConnectCommand",
            value=f"aws ssm start-session --target {instance.instance_id} --region {self.region}",
            description="Command to connect via SSM Session Manager",
        )
        CfnOutput(
            self,
            "BadTableName",
            value=bad_table,
            description="Bad table name (hot partition design)",
        )
        CfnOutput(
            self,
            "GoodTableName",
            value=good_table,
            description="Good table name (distributed design)",
        )
