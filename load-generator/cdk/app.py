#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stack import LoadGeneratorStack

app = cdk.App()
LoadGeneratorStack(
    app,
    "LoadGeneratorStack",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION", "us-west-2"),
    ),
)
app.synth()
