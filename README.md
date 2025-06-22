# Meraki Splash Page with RADIUS Authentication

A simple and customizable RADIUS authentication splash page for Meraki networks that checks for a specific Filter-ID before granting network access.

## Features

- RADIUS authentication for Meraki splash pages
- Filter-ID based access control
- Customizable error messages
- Containerized for easy deployment in ECS or any Docker environment
- Environment variable configuration

## Environment Variables

The application uses the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port the server will listen on | `3000` |
| `RADIUS_HOST` | RADIUS server hostname or IP address | `13.213.197.42` |
| `RADIUS_PORT` | RADIUS server port | `1812` |
| `RADIUS_SECRET` | RADIUS server shared secret | `testing123` |
| `ALLOWED_FILTER_ID` | The Filter-ID that should be granted access | `StaffPolicy` |
| `ACCESS_DENIED_MESSAGE` | Message to show when access is denied | `You don't belong to this SSID` |

## Docker Build & Run

Build the Docker image:

```bash
docker build -t meraki-radius-auth .
```

Run the container with default settings:

```bash
docker run -p 3000:3000 meraki-radius-auth
```

Run with custom environment variables:

```bash
docker run -p 3000:3000 \
  -e RADIUS_HOST=10.0.0.1 \
  -e RADIUS_SECRET=mysecret \
  -e ALLOWED_FILTER_ID=EmployeePolicy \
  meraki-radius-auth
```

## AWS ECS Deployment

### Prerequisites

- AWS CLI configured with appropriate permissions
- An ECR repository to store your Docker image
- An ECS cluster

### Deploying to ECS

1. **Build and push the Docker image to ECR**

```bash
# Login to ECR
aws ecr get-login-password --region your-region | docker login --username AWS --password-stdin your-account-id.dkr.ecr.your-region.amazonaws.com

# Build and tag the image
docker build -t meraki-radius-auth .
docker tag meraki-radius-auth:latest your-account-id.dkr.ecr.your-region.amazonaws.com/meraki-radius-auth:latest

# Push the image to ECR
docker push your-account-id.dkr.ecr.your-region.amazonaws.com/meraki-radius-auth:latest
```

2. **Create a task definition**

Create a file named `task-definition.json`:

```json
{
  "family": "meraki-radius-auth",
  "networkMode": "awsvpc",
  "executionRoleArn": "arn:aws:iam::your-account-id:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "meraki-radius-auth",
      "image": "your-account-id.dkr.ecr.your-region.amazonaws.com/meraki-radius-auth:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3000,
          "hostPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "RADIUS_HOST",
          "value": "your-radius-server"
        },
        {
          "name": "RADIUS_SECRET",
          "value": "your-radius-secret"
        },
        {
          "name": "ALLOWED_FILTER_ID",
          "value": "StaffPolicy"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/meraki-radius-auth",
          "awslogs-region": "your-region",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "requiresCompatibilities": [
    "FARGATE"
  ],
  "cpu": "256",
  "memory": "512"
}
```

Register the task definition:

```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

3. **Create a service**

```bash
aws ecs create-service \
  --cluster your-cluster \
  --service-name meraki-radius-auth \
  --task-definition meraki-radius-auth \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-12345678],securityGroups=[sg-12345678],assignPublicIp=ENABLED}"
```

## Testing

Once deployed, you can test the server by accessing the `/test-splash` endpoint. For ECS deployments, you'll need to make sure your service is behind a load balancer or has a public IP assigned.

## Security Notes

1. Always use secure RADIUS_SECRET values in production
2. Consider using AWS Secrets Manager for storing the RADIUS_SECRET in ECS
3. Make sure your security groups allow UDP traffic to your RADIUS server on the appropriate port